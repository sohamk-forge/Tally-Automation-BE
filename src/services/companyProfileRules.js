// Pure rules for a company's profile: is it GST, and how does each voucher type number
// itself. No database here so the rules can be tested on their own;
// companyProfile.service.js loads the data and calls these.

export const GST_MODE = { GST: "gst", NON_GST: "non_gst", UNKNOWN: "unknown" };
export const NUMBERING = {
  AUTOMATIC: "automatic",
  MANUAL: "manual",
  OVERRIDE: "override",
  NONE: "none",
  UNKNOWN: "unknown"
};

// Tally's NUMBERINGMETHOD text -> one of NUMBERING. Values seen in synced data:
//   "Automatic", "Automatic (Manual Override)", "Manual", "Default", "None".
// "Default" is what built-in types (Payment, Purchase, Receipt...) report when nobody changed
// them, and their synced vouchers number themselves 1, 2, 3..., so it counts as automatic.
// Anything not recognised is "unknown" (never silently automatic) so it stays visible.
export function normalizeNumbering(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return NUMBERING.UNKNOWN;
  if (t.includes("override")) return NUMBERING.OVERRIDE;
  if (t === "manual") return NUMBERING.MANUAL;
  if (t === "automatic" || t === "default") return NUMBERING.AUTOMATIC;
  if (t === "none") return NUMBERING.NONE;
  return NUMBERING.UNKNOWN;
}

// Does the app have to put a voucher number in the push? Tally only numbers the push itself for
// automatic types (and "none" needs no number). Unknown stays false for now, which is what the
// code did before; blocking on unknown is a separate step.
export function modeNeedsAppNumber(mode) {
  return mode === NUMBERING.MANUAL || mode === NUMBERING.OVERRIDE;
}

// Can the user type their own number for this type? Only Manual and Override allow it.
export function modeAllowsUserNumber(mode) {
  return mode === NUMBERING.MANUAL || mode === NUMBERING.OVERRIDE;
}

// company_details row (or null if never synced) -> GST facts.
export function gstFromDetails(details) {
  if (!details) return { mode: GST_MODE.UNKNOWN, gstin: null, registrationType: null };
  const gstin = String(details.gstin ?? "").trim();
  return {
    mode: gstin ? GST_MODE.GST : GST_MODE.NON_GST,
    gstin: gstin || null,
    registrationType: details.gst_registration_type || null
  };
}

// voucher_types rows -> { [lowercased type name]: { name, base_type, raw, mode } }
export function numberingFromTypes(voucherTypes = []) {
  const types = {};
  for (const t of voucherTypes) {
    const key = String(t.name ?? "").trim().toLowerCase();
    if (!key) continue;
    types[key] = {
      name: t.name,
      base_type: t.base_type || null,
      raw: t.numbering_method ?? null,
      mode: normalizeNumbering(t.numbering_method)
    };
  }
  return types;
}

export function buildProfile({ details, voucherTypes }) {
  return { gst: gstFromDetails(details), numbering: numberingFromTypes(voucherTypes) };
}

// Numbering mode of one voucher type by its Tally name; "unknown" if the type was never synced.
export function numberingModeFor(profile, typeName) {
  const key = String(typeName ?? "").trim().toLowerCase();
  return profile?.numbering?.[key]?.mode ?? NUMBERING.UNKNOWN;
}

// Can this company take a push right now? A push needs to know how the voucher type numbers
// itself, and (for sales/purchase) whether the company is GST. When the profile has gaps the push
// is refused with a plain message instead of guessing. typeName is the Tally voucher type the push
// will use; needsGst is true for vouchers that carry GST ledgers (sales, purchase).
export function checkPushReadiness(profile, { typeName, needsGst = false } = {}) {
  const problems = [];
  if (needsGst && profile?.gst?.mode === GST_MODE.UNKNOWN) {
    problems.push({ kind: "not_synced", text: "its company details (GST status) have not been synced" });
  }
  const key = String(typeName ?? "").trim().toLowerCase();
  const entry = profile?.numbering?.[key];
  if (!entry) {
    problems.push({ kind: "not_synced", text: `voucher type "${typeName}" has not been synced` });
  } else if (entry.mode === NUMBERING.UNKNOWN) {
    const raw = String(entry.raw ?? "").trim();
    problems.push(raw
      ? { kind: "unsupported", text: `voucher type "${entry.name}" has a numbering setting ("${raw}") this app does not support yet` }
      : { kind: "not_synced", text: `the numbering of voucher type "${entry.name}" has not been synced` });
  }
  return { ok: problems.length === 0, problems };
}

export function readinessMessage(companyName, problems) {
  const list = problems.map((p) => p.text).join("; ");
  const advice = problems.some((p) => p.kind === "not_synced")
    ? "Sync this company, then push again."
    : "Use a supported numbering setting in Tally, or ask for support to be added.";
  return `${companyName || "This company"} is not ready to push: ${list}. ${advice}`;
}
