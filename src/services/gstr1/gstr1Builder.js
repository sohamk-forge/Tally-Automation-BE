// src/services/gstr1/gstr1Builder.js
//
// Pure GSTR-1 builder: Tally vouchers (as synced into app_test.vouchers) +
// master lookups -> the PUT /gstr1/retsave payload, a per-invoice breakdown
// for the review screen, and a list of issues. No DB, no network — the
// caller (gstr1Prepare.service.js) loads the inputs.
//
// Severity: "error" blocks saving to GSTN, "warning" is shown but allowed.

import { isValidGstin, stateCodeFromName, uqcFromUnit, GST_SLABS } from "./gstMasters.js";

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
export const normName = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

// GSTR-1 invoice numbers: max 16 chars of letters, digits, "/" and "-".
const INUM_RE = /^(?=.{1,16}$)([/\-0]*[a-zA-Z0-9/\-]*[a-zA-Z1-9]+[a-zA-Z0-9/\-]*)$/;

/** B2CL threshold: ₹2.5 lakh before 1 Aug 2024, ₹1 lakh from then on. */
const b2clThreshold = (isoDate) => (isoDate >= "2024-08-01" ? 100000 : 250000);

/** Voucher type -> INVOICE | CREDIT | DEBIT */
function voucherKind(type) {
  if (/credit\s*note|sales\s*return/i.test(type)) return "CREDIT";
  if (/debit\s*note/i.test(type)) return "DEBIT";
  return "INVOICE";
}

/** What a ledger line on a sales voucher is, by its name (and master group). */
function lineRole(name, master, hasInventory) {
  if (hasInventory) return "income";
  const n = String(name || "");
  if (/round/i.test(n)) return "roundoff";
  if (/\b(tds|tcs)\b/i.test(n)) return "ignore";
  const looksLikeSales = /sales|income|revenue/i.test(n);
  const isDutyGroup = /duties|tax/i.test(master?.parent_group || "");
  if (!looksLikeSales || isDutyGroup) {
    if (/cess/i.test(n)) return "cess";
    if (/igst|integrated/i.test(n)) return "igst";
    if (/cgst|central\s*(gst|tax)/i.test(n)) return "cgst";
    if (/sgst|utgst|state\s*(gst|tax)/i.test(n)) return "sgst";
  }
  return "income";
}

/** "103 Mtr." -> { qty: 103, unit: "Mtr." } */
function parseQty(s) {
  const m = /^\s*(-?[\d.,]+)\s*(.*)$/.exec(String(s || ""));
  return m ? { qty: num(m[1]), unit: m[2].trim() } : { qty: 0, unit: "" };
}

function nearestSlab(rate) {
  let best = null;
  for (const s of GST_SLABS) if (best === null || Math.abs(s - rate) < Math.abs(best - rate)) best = s;
  return Math.abs(best - rate) <= Math.max(0.05, rate * 0.004) ? best : null;
}

/** Split `total` across `weights` so the parts sum exactly to `total` (2 dp). */
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? r2(total) : 0));
  let used = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return r2(total - used);
    const part = r2((total * w) / sum);
    used += part;
    return part;
  });
}

/**
 * @param {object} input
 * @param {string} input.supplierGstin
 * @param {{retPeriod:string, fromDate:string, toDate:string}} input.period
 * @param {Array} input.vouchers   rows: { id, voucher_type, voucher_number, idt (DD-MM-YYYY), date (YYYY-MM-DD), party_ledger_name, ledger_entries,
 *                                 party_gstin?, place_of_supply?, is_cancelled?, is_optional? } — the last four from the voucher header (synced from Tally)
 * @param {Map} input.ledgers      normName -> { gst_number, state, country, parent_group, gst_registration_type }
 * @param {Map} input.items        normName -> { hsn, rate, unit, source }
 * @param {Map} input.overrides    normName -> { hsn_code, gst_rate, uqc, description }
 * @param {object} [input.options] { hsnMinDigits: 4 | 6 }
 */
export function buildGstr1({ supplierGstin, period, vouchers, ledgers, items, overrides, options = {} }) {
  const hsnMinDigits = options.hsnMinDigits || 6;
  const supplierState = supplierGstin.slice(0, 2);
  const issues = [];
  const issue = (severity, code, message, ref = {}) => issues.push({ severity, code, message, ...ref });

  const invoices = [];
  const excluded = [];
  const seenInum = new Map();
  const assumedRates = []; // invoices where one rate was assumed for several different items
  const cancelledDocs = []; // { kind, inum } — reported in Table 13 as cancelled

  for (const v of vouchers) {
    const ref = { voucherId: v.id, voucherNumber: v.voucher_number };
    const kind = voucherKind(v.voucher_type);
    const entries = asArray(v.ledger_entries);
    const partyKey = normName(v.party_ledger_name);
    const party = ledgers.get(partyKey) || null;

    // Cancelled and optional (memorandum) vouchers are never reported.
    if (v.is_cancelled || v.is_optional) {
      excluded.push({ ...ref, voucherType: v.voucher_type, reason: v.is_cancelled ? "Cancelled in Tally — counted as cancelled in Documents Issued" : "Optional voucher in Tally (not a real invoice)" });
      if (v.is_cancelled && v.voucher_number) cancelledDocs.push({ kind, inum: String(v.voucher_number).trim() });
      continue;
    }

    // Notes to suppliers are purchase returns — not part of GSTR-1.
    if (kind !== "INVOICE" && /sundry\s*creditor/i.test(party?.parent_group || "")) {
      excluded.push({ ...ref, voucherType: v.voucher_type, reason: "Note against a supplier (Sundry Creditors) — purchase side, not GSTR-1" });
      continue;
    }

    // ---- split ledger lines by role
    let partyLine = entries.find((e) => normName(e.LEDGERNAME) === partyKey);
    if (!partyLine) {
      // party name spelt differently: the largest line on the deemed-positive side
      partyLine = entries
        .filter((e) => String(e.ISDEEMEDPOSITIVE).toLowerCase() === (kind === "CREDIT" ? "no" : "yes"))
        .sort((a, b) => Math.abs(num(b.AMOUNT)) - Math.abs(num(a.AMOUNT)))[0];
    }
    if (!partyLine || !num(partyLine.AMOUNT)) {
      excluded.push({ ...ref, voucherType: v.voucher_type, reason: "No amount on the party line — likely a cancelled or empty voucher" });
      issue("warning", "EMPTY_VOUCHER", `${v.voucher_type} ${v.voucher_number} has no amount and was skipped (cancelled in Tally?)`, ref);
      continue;
    }
    // income/tax lines carry the opposite sign of the party line
    const s = -Math.sign(num(partyLine.AMOUNT));

    const lines = []; // { name, hsn, rate, uqc, qty, txval, source }
    const charges = []; // income lines without inventory, to apportion
    const tax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    let roundOff = 0;

    for (const e of entries) {
      if (e === partyLine) continue;
      const inv = asArray(e["INVENTORYALLOCATIONS.LIST"]);
      const role = lineRole(e.LEDGERNAME, ledgers.get(normName(e.LEDGERNAME)), inv.length > 0);
      const amt = r2(num(e.AMOUNT) * s);
      if (role === "roundoff") { roundOff += amt; continue; }
      if (role === "ignore") continue;
      if (role in tax) { tax[role] += amt; continue; }

      if (inv.length) {
        let itemsTotal = 0;
        for (const it of inv) {
          const { qty, unit } = parseQty(it.BILLEDQTY || it.ACTUALQTY);
          const txval = r2(num(it.AMOUNT) * s);
          itemsTotal += txval;
          lines.push({ name: it.STOCKITEMNAME, kind: "item", qty: Math.abs(qty), unit, txval, voucherHsn: it.GSTHSNSACCODE || e.GSTHSNSACCODE, voucherRate: it.GSTTAXRATE ?? e.GSTTAXRATE });
        }
        const residual = r2(amt - itemsTotal);
        if (Math.abs(residual) >= 0.01) charges.push({ name: e.LEDGERNAME, txval: residual });
      } else if (e.GSTHSNSACCODE) {
        lines.push({ name: e.LEDGERNAME, kind: "ledger", qty: 0, unit: "", txval: amt, voucherHsn: e.GSTHSNSACCODE, voucherRate: e.GSTTAXRATE });
      } else {
        charges.push({ name: e.LEDGERNAME, txval: amt });
      }
    }

    // Additional charges (freight, packing…) on an item invoice are part of
    // the taxable value of those items; on a pure ledger invoice each charge
    // is a service line of its own.
    if (charges.length) {
      if (lines.some((l) => l.kind === "item")) {
        const itemLines = lines.filter((l) => l.kind === "item");
        const add = apportion(charges.reduce((a, c) => a + c.txval, 0), itemLines.map((l) => l.txval));
        itemLines.forEach((l, i) => { l.txval = r2(l.txval + add[i]); });
        issue("warning", "CHARGES_APPORTIONED", `${v.voucher_number}: ${charges.map((c) => c.name).join(", ")} added to the items' taxable value`, ref);
      } else {
        for (const c of charges) lines.push({ name: c.name, kind: "ledger", qty: 0, unit: "", txval: c.txval });
      }
    }

    const taxable = r2(lines.reduce((a, l) => a + l.txval, 0));
    if (!lines.length || taxable <= 0) {
      issue("error", "NO_TAXABLE_VALUE", `${v.voucher_type} ${v.voucher_number}: no sales lines with a taxable value found`, ref);
      continue;
    }

    // ---- recipient
    // The GSTIN on the voucher wins over the ledger master's (Tally lets a
    // voucher carry a different registration of the same party).
    const rawGstin = String(v.party_gstin || party?.gst_number || "").trim().toUpperCase();
    const registered = isValidGstin(rawGstin);
    if (rawGstin && !registered) {
      issue("warning", "INVALID_GSTIN", `${v.voucher_number}: GSTIN "${rawGstin}" on ledger ${v.party_ledger_name} is invalid — reported as unregistered`, ref);
    }
    if (registered && rawGstin === supplierGstin.toUpperCase()) {
      issue("error", "SELF_GSTIN", `${v.voucher_number}: the buyer's GSTIN is your own GSTIN — GSTN doesn't accept an invoice to yourself`, ref);
      continue;
    }
    if (party?.country && !/^india$/i.test(party.country.trim())) {
      issue("error", "EXPORT_UNSUPPORTED", `${v.voucher_number}: party is in ${party.country} — export invoices aren't supported yet`, ref);
      continue;
    }

    // ---- place of supply + supply type
    const taxTotal = r2(tax.igst + tax.cgst + tax.sgst);
    let pos = registered ? rawGstin.slice(0, 2) : stateCodeFromName(v.place_of_supply) || stateCodeFromName(party?.state);
    if (tax.igst && (tax.cgst || tax.sgst)) {
      issue("error", "MIXED_TAX", `${v.voucher_number}: has both IGST and CGST/SGST`, ref);
      continue;
    }
    let supplyType = tax.igst > 0 ? "INTER" : tax.cgst + tax.sgst > 0 ? "INTRA" : null;
    if (!pos) {
      pos = supplyType === "INTER" ? null : supplierState;
      if (!pos) {
        issue("error", "POS_UNKNOWN", `${v.voucher_number}: IGST charged but the buyer's state is unknown — set the state on ledger ${v.party_ledger_name}`, ref);
        continue;
      }
      issue("warning", "POS_DEFAULTED", `${v.voucher_number}: buyer state missing on ledger ${v.party_ledger_name} — place of supply taken as your own state`, ref);
    }
    if (!supplyType) supplyType = pos === supplierState ? "INTRA" : "INTER";
    if (supplyType === "INTRA" && pos !== supplierState) {
      issue("error", "POS_TAX_CONFLICT", `${v.voucher_number}: CGST/SGST charged but place of supply is state ${pos} — inter-state sales need IGST`, ref);
      continue;
    }
    if (supplyType === "INTER" && pos === supplierState) {
      issue("error", "POS_TAX_CONFLICT", `${v.voucher_number}: IGST charged but place of supply is your own state ${pos} — intra-state sales need CGST/SGST`, ref);
      continue;
    }

    // ---- HSN / rate / UQC per line
    for (const l of lines) {
      const key = normName(l.name);
      const ov = overrides.get(key);
      const master = l.kind === "item" ? items.get(key) : null;
      l.hsn = String(ov?.hsn_code || l.voucherHsn || master?.hsn || "").replace(/\s+/g, "");
      l.hsnSource = ov?.hsn_code ? "override" : l.voucherHsn ? "voucher" : master?.hsn ? master.source : null;
      const knownRate = [ov?.gst_rate, l.voucherRate, master?.rate].map(num).find((x) => x > 0);
      l.rate = knownRate ?? null;
      l.rateSource = knownRate == null ? null : num(ov?.gst_rate) > 0 ? "override" : num(l.voucherRate) > 0 ? "voucher" : "master";
      l.uqc = String(ov?.uqc || "").toUpperCase() || (l.hsn.startsWith("99") ? "NA" : uqcFromUnit(l.unit || master?.unit));
      if (l.uqc === "NA") l.qty = 0;
    }

    // Rates not in any master: infer from the tax actually charged.
    const unknown = lines.filter((l) => l.rate == null);
    if (unknown.length) {
      const knownTax = lines.filter((l) => l.rate != null).reduce((a, l) => a + (l.txval * l.rate) / 100, 0);
      const unknownTaxable = unknown.reduce((a, l) => a + l.txval, 0);
      const slab = nearestSlab(((taxTotal - knownTax) / unknownTaxable) * 100);
      if (slab == null) {
        issue("error", "RATE_UNKNOWN", `${v.voucher_number}: can't work out the GST rate of ${unknown.map((l) => l.name).join(", ")} (items at different rates) — set the rate for these items`, { ...ref, items: unknown.map((l) => l.name) });
        continue;
      }
      for (const l of unknown) { l.rate = slab; l.rateSource = "inferred"; }
      const distinct = [...new Set(unknown.map((l) => l.name))];
      if (distinct.length > 1) assumedRates.push({ voucherNumber: v.voucher_number, rate: slab, items: distinct });
    }

    // Tax charged must match taxable × rate.
    const expected = lines.reduce((a, l) => a + (l.txval * l.rate) / 100, 0);
    if (Math.abs(expected - taxTotal) > Math.max(1, expected * 0.005)) {
      issue("error", "TAX_MISMATCH", `${v.voucher_number}: tax charged ₹${taxTotal.toFixed(2)} but taxable value × rate gives ₹${expected.toFixed(2)}`, ref);
      continue;
    }

    // Spread the voucher's actual tax amounts over its lines.
    const weights = lines.map((l) => l.txval * l.rate);
    const ig = apportion(tax.igst, weights);
    const cg = apportion(tax.cgst, weights);
    const sg = apportion(tax.sgst, weights);
    const cs = apportion(tax.cess, lines.map((l) => l.txval));
    lines.forEach((l, i) => Object.assign(l, { iamt: ig[i], camt: cg[i], samt: sg[i], csamt: cs[i] }));

    // HSN checks (per line, blocking)
    let hsnOk = true;
    for (const l of lines) {
      if (!l.hsn) {
        hsnOk = false;
        issue("error", "HSN_MISSING", `${v.voucher_number}: no HSN/SAC for "${l.name}"`, { ...ref, item: l.name });
      } else if (!/^(\d{2}|\d{4}|\d{6}|\d{8})$/.test(l.hsn)) {
        hsnOk = false;
        issue("error", "HSN_INVALID", `${v.voucher_number}: HSN "${l.hsn}" for "${l.name}" must be 2, 4, 6 or 8 digits`, { ...ref, item: l.name });
      } else if (l.hsn.length < hsnMinDigits) {
        hsnOk = false;
        issue("error", "HSN_TOO_SHORT", `${v.voucher_number}: HSN ${l.hsn} for "${l.name}" has ${l.hsn.length} digits; at least ${hsnMinDigits} are required`, { ...ref, item: l.name });
      }
    }

    // Invoice number checks
    const inum = String(v.voucher_number || "").trim();
    if (!INUM_RE.test(inum)) {
      issue("error", "INUM_INVALID", `Invoice number "${inum}" isn't valid for GSTN (max 16 characters: letters, digits, / and -)`, ref);
    }
    const dupKey = `${kind}|${inum.toUpperCase()}`;
    if (seenInum.has(dupKey)) {
      issue("error", "DUPLICATE_INUM", `Number ${inum} is used twice in this period`, ref);
    }
    seenInum.set(dupKey, v.id);

    const val = r2(taxable + taxTotal + tax.cess + roundOff);
    const interStateLarge = supplyType === "INTER" && val > b2clThreshold(v.date);
    let section;
    let reason;
    if (kind === "INVOICE") {
      if (registered) { section = "b2b"; reason = "Buyer has a registered GSTIN"; }
      else if (interStateLarge) { section = "b2cl"; reason = `Unregistered, inter-state, invoice value over ₹${b2clThreshold(v.date).toLocaleString("en-IN")}`; }
      else { section = "b2cs"; reason = supplyType === "INTRA" ? "Unregistered, intra-state" : "Unregistered, inter-state, below the B2CL limit"; }
    } else {
      if (registered) { section = "cdnr"; reason = `${kind === "CREDIT" ? "Credit" : "Debit"} note to a registered buyer`; }
      else if (interStateLarge) { section = "cdnur"; reason = "Note to an unregistered buyer, inter-state, over the B2CL limit"; }
      else { section = "b2cs"; reason = "Note to an unregistered buyer — adjusts B2CS"; }
    }
    if (registered && /consumer|unregistered/i.test(party?.gst_registration_type || "")) {
      issue("warning", "REG_TYPE_MISMATCH", `${inum}: ledger ${v.party_ledger_name} is marked "${party.gst_registration_type}" but has GSTIN ${rawGstin} — reported as B2B`, ref);
    }
    if (registered && /sez/i.test(party?.gst_registration_type || "")) reason += " (SEZ)";

    invoices.push({
      voucherId: v.id,
      voucherType: v.voucher_type,
      kind,
      inum,
      idt: v.idt,
      date: v.date,
      partyName: v.party_ledger_name,
      ctin: registered ? rawGstin : null,
      sez: registered && /sez/i.test(party?.gst_registration_type || ""),
      pos,
      supplyType,
      val,
      taxable,
      tax: { igst: r2(tax.igst), cgst: r2(tax.cgst), sgst: r2(tax.sgst), cess: r2(tax.cess) },
      section,
      reason,
      hsnOk,
      lines: lines.map(({ name, hsn, hsnSource, rate, rateSource, uqc, qty, txval, iamt, camt, samt, csamt }) => ({ name, hsn, hsnSource, rate, rateSource, uqc, qty, txval, iamt, camt, samt, csamt })),
    });
  }

  if (assumedRates.length) {
    const items = [...new Set(assumedRates.flatMap((a) => a.items))];
    issue("warning", "RATE_ASSUMED",
      `On ${assumedRates.length} invoice(s) the GST rate isn't in the item masters, so one rate was assumed for all items from the tax charged (e.g. ${assumedRates[0].voucherNumber} at ${assumedRates[0].rate}%). If those items are at different rates — say one is nil-rated — set their rates: ${items.slice(0, 8).join(", ")}${items.length > 8 ? ` and ${items.length - 8} more` : ""}`,
      { items, voucherNumbers: assumedRates.map((a) => a.voucherNumber) });
  }

  const payload = assemblePayload({ supplierGstin, period, invoices, cancelledDocs, issue });
  const sections = summarizeSections(invoices, payload);

  // The HSN table must account for exactly the value reported in the
  // invoice tables (GSTN's validatehsnsum checks the same).
  if (invoices.every((inv) => inv.hsnOk)) {
    const hsnRow = sections.find((s) => s.key === "hsn");
    const invTotal = sections.filter((s) => ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "nil"].includes(s.key)).reduce((a, s) => a + (s.taxable || 0), 0);
    if (Math.abs(r2(invTotal) - (hsnRow?.taxable || 0)) > 1) {
      issue("error", "HSN_TOTAL_MISMATCH", `HSN summary taxable value ₹${hsnRow?.taxable} doesn't match the invoice tables' ₹${r2(invTotal)}`, { section: "hsn" });
    }
  }
  const errorCount = issues.filter((i) => i.severity === "error").length;

  return {
    payload,
    sections,
    invoices,
    excluded,
    issues,
    stats: {
      vouchersRead: vouchers.length,
      invoicesIncluded: invoices.length,
      excluded: excluded.length,
      errors: errorCount,
      warnings: issues.length - errorCount,
      isNil: invoices.length === 0,
    },
  };
}

/* ------------------------------------------------------------------ */

function itemsByRate(lines, taxKeys) {
  const byRate = new Map();
  for (const l of lines) {
    if (!(l.rate > 0)) continue;
    const a = byRate.get(l.rate) || { rt: l.rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    a.txval += l.txval; a.iamt += l.iamt; a.camt += l.camt; a.samt += l.samt; a.csamt += l.csamt;
    byRate.set(l.rate, a);
  }
  return [...byRate.values()].map((a, i) => {
    const det = { txval: r2(a.txval), rt: a.rt };
    for (const k of taxKeys) det[k] = r2(a[k]);
    det.csamt = r2(a.csamt);
    return { num: i + 1, itm_det: det };
  });
}

const taxKeysFor = (supplyType) => (supplyType === "INTER" ? ["iamt"] : ["camt", "samt"]);

function assemblePayload({ supplierGstin, period, invoices, cancelledDocs = [], issue }) {
  const payload = { gstin: supplierGstin, fp: period.retPeriod };

  const b2b = new Map();
  const b2cl = new Map();
  const b2cs = new Map();
  const cdnr = new Map();
  const cdnur = [];
  const nil = new Map();
  const hsn = { b2b: new Map(), b2c: new Map() };
  const docs = { 1: [], 4: [], 5: [] };

  for (const inv of invoices) {
    const sign = inv.kind === "CREDIT" ? -1 : 1;
    const taxed = inv.lines.filter((l) => l.rate > 0);
    const nilLines = inv.lines.filter((l) => !(l.rate > 0));
    const itms = itemsByRate(taxed, taxKeysFor(inv.supplyType));
    const rchrg = "N";

    if (taxed.length) {
      if (inv.section === "b2b") {
        const invTyp = inv.sez ? (inv.tax.igst > 0 ? "SEWP" : "SEWOP") : "R";
        const list = b2b.get(inv.ctin) || [];
        list.push({ inum: inv.inum, idt: inv.idt, val: inv.val, pos: inv.pos, rchrg, inv_typ: invTyp, itms });
        b2b.set(inv.ctin, list);
      } else if (inv.section === "b2cl") {
        const list = b2cl.get(inv.pos) || [];
        list.push({ inum: inv.inum, idt: inv.idt, val: inv.val, itms: itemsByRate(taxed, ["iamt"]) });
        b2cl.set(inv.pos, list);
      } else if (inv.section === "cdnr") {
        const list = cdnr.get(inv.ctin) || [];
        list.push({ ntty: inv.kind === "CREDIT" ? "C" : "D", nt_num: inv.inum, nt_dt: inv.idt, val: inv.val, pos: inv.pos, rchrg, inv_typ: inv.sez ? (inv.tax.igst > 0 ? "SEWP" : "SEWOP") : "R", itms });
        cdnr.set(inv.ctin, list);
      } else if (inv.section === "cdnur") {
        cdnur.push({ typ: "B2CL", ntty: inv.kind === "CREDIT" ? "C" : "D", nt_num: inv.inum, nt_dt: inv.idt, val: inv.val, pos: inv.pos, itms: itemsByRate(taxed, ["iamt"]) });
      } else if (inv.section === "b2cs") {
        for (const l of taxed) {
          const k = `${inv.supplyType}|${inv.pos}|${l.rate}`;
          const a = b2cs.get(k) || { sply_ty: inv.supplyType, pos: inv.pos, typ: "OE", rt: l.rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
          a.txval += sign * l.txval; a.iamt += sign * l.iamt; a.camt += sign * l.camt; a.samt += sign * l.samt; a.csamt += sign * l.csamt;
          b2cs.set(k, a);
        }
      }
    }

    for (const l of nilLines) {
      const sply = `${inv.supplyType === "INTER" ? "INTR" : "INTRA"}${inv.ctin ? "B2B" : "B2C"}`;
      nil.set(sply, (nil.get(sply) || 0) + sign * l.txval);
    }

    const hsnBucket = inv.ctin ? hsn.b2b : hsn.b2c;
    for (const l of inv.lines) {
      if (!l.hsn) continue;
      const k = `${l.hsn}|${l.rate}|${l.uqc}`;
      const a = hsnBucket.get(k) || { hsn_sc: l.hsn, uqc: l.uqc, rt: l.rate, qty: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      a.qty += sign * l.qty; a.txval += sign * l.txval; a.iamt += sign * l.iamt; a.camt += sign * l.camt; a.samt += sign * l.samt; a.csamt += sign * l.csamt;
      hsnBucket.set(k, a);
    }

    docs[inv.kind === "INVOICE" ? 1 : inv.kind === "DEBIT" ? 4 : 5].push({ n: inv.inum, cancelled: false });
  }
  for (const c of cancelledDocs) docs[c.kind === "INVOICE" ? 1 : c.kind === "DEBIT" ? 4 : 5].push({ n: c.inum, cancelled: true });

  if (b2b.size) payload.b2b = [...b2b].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2cl.size) payload.b2cl = [...b2cl].map(([pos, inv]) => ({ pos, inv }));
  if (b2cs.size) {
    payload.b2cs = [...b2cs.values()].map((a) => {
      const row = { sply_ty: a.sply_ty, pos: a.pos, typ: a.typ, rt: a.rt, txval: r2(a.txval) };
      for (const k of taxKeysFor(a.sply_ty)) row[k] = r2(a[k]);
      row.csamt = r2(a.csamt);
      if (row.txval < 0) issue("warning", "NEGATIVE_B2CS", `B2CS for place of supply ${a.pos} at ${a.rt}% is negative (₹${row.txval}) after credit notes — GSTN accepts a net negative, but check the credit notes belong to this period`, { section: "b2cs" });
      return row;
    });
  }
  if (cdnr.size) payload.cdnr = [...cdnr].map(([ctin, nt]) => ({ ctin, nt }));
  if (cdnur.length) payload.cdnur = cdnur;
  if (nil.size) payload.nil = { inv: [...nil].map(([sply_ty, amt]) => ({ sply_ty, nil_amt: r2(amt), expt_amt: 0, ngsup_amt: 0 })) };

  const hsnRows = (m) => [...m.values()].map((a, i) => ({
    num: i + 1, hsn_sc: a.hsn_sc, uqc: a.uqc, qty: r2(a.qty), rt: a.rt,
    txval: r2(a.txval), iamt: r2(a.iamt), camt: r2(a.camt), samt: r2(a.samt), csamt: r2(a.csamt),
  }));
  if (hsn.b2b.size || hsn.b2c.size) {
    payload.hsn = {};
    if (hsn.b2b.size) payload.hsn.hsn_b2b = hsnRows(hsn.b2b);
    if (hsn.b2c.size) payload.hsn.hsn_b2c = hsnRows(hsn.b2c);
  }

  const DOC_TYPES = { 1: "Invoices for outward supply", 4: "Debit Note", 5: "Credit Note" };
  const docDet = Object.entries(docs)
    .filter(([, list]) => list.length)
    .map(([docNum, list]) => ({ doc_num: String(docNum), doc_typ: DOC_TYPES[docNum], docs: documentSeries(list) }));
  if (docDet.length) payload.doc_issue = { doc_det_new: docDet };

  return payload;
}

/**
 * Group document numbers into series by prefix ("26-27/06/") and report
 * from / to / total / cancelled / net issued (Table 13).
 */
function documentSeries(docs) {
  const series = new Map();
  for (const { n, cancelled } of docs) {
    const m = /^(.*?)(\d+)$/.exec(n);
    const prefix = m ? m[1] : n;
    const list = series.get(prefix) || [];
    list.push({ n, seq: m ? parseInt(m[2], 10) : 0, cancelled });
    series.set(prefix, list);
  }
  return [...series.values()].map((list, i) => {
    list.sort((a, b) => a.seq - b.seq || a.n.localeCompare(b.n));
    const cancel = list.filter((d) => d.cancelled).length;
    return { num: i + 1, from: list[0].n, to: list[list.length - 1].n, totnum: list.length, cancel, net_issue: list.length - cancel };
  });
}

const SECTION_LABELS = [
  ["b2b", "B2B Invoices"],
  ["b2cl", "B2CL Invoices"],
  ["b2cs", "B2CS Invoices"],
  ["cdnr", "Credit/Debit Notes (Registered)"],
  ["cdnur", "Credit/Debit Notes (Unregistered)"],
  ["exp", "Exports Invoices (EXP)"],
  ["nil", "Nil Rated, Exempted & Non-GST"],
  ["at", "Advances Received"],
  ["atadj", "Advances Adjusted"],
  ["hsn", "HSN-wise Summary"],
  ["doc", "Documents Issued"],
];

/** Rows for the review table: one per GSTR-1 table, with doc counts and totals. */
function summarizeSections(invoices, payload) {
  const totals = (list) => list.reduce((a, inv) => {
    const sign = inv.kind === "CREDIT" ? -1 : 1;
    const taxed = inv.lines.filter((l) => l.rate > 0);
    a.taxable += sign * taxed.reduce((x, l) => x + l.txval, 0);
    a.igst += sign * taxed.reduce((x, l) => x + l.iamt, 0);
    a.cgst += sign * taxed.reduce((x, l) => x + l.camt, 0);
    a.sgst += sign * taxed.reduce((x, l) => x + l.samt, 0);
    a.cess += sign * taxed.reduce((x, l) => x + l.csamt, 0);
    return a;
  }, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const round = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r2(v)]));

  return SECTION_LABELS.map(([key, label]) => {
    if (key === "hsn") {
      const rows = [...(payload.hsn?.hsn_b2b || []), ...(payload.hsn?.hsn_b2c || [])];
      const t = rows.reduce((a, h) => ({ taxable: a.taxable + h.txval, igst: a.igst + h.iamt, cgst: a.cgst + h.camt, sgst: a.sgst + h.samt, cess: a.cess + h.csamt }), { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
      return { key, label, docs: rows.length, ...round(t), empty: !rows.length };
    }
    if (key === "doc") {
      const n = (payload.doc_issue?.doc_det_new || []).reduce((a, d) => a + d.docs.reduce((x, s) => x + s.totnum, 0), 0);
      return { key, label, docs: n, docsOnly: true, empty: !n };
    }
    if (key === "nil") {
      const rows = payload.nil?.inv || [];
      const t = rows.reduce((a, r) => a + r.nil_amt + r.expt_amt + r.ngsup_amt, 0);
      const docs = invoices.filter((inv) => inv.lines.some((l) => !(l.rate > 0))).length;
      return { key, label, docs, taxable: r2(t), igst: 0, cgst: 0, sgst: 0, cess: 0, empty: !rows.length };
    }
    const list = invoices.filter((inv) => inv.section === key);
    return { key, label, docs: list.length, ...round(totals(list)), empty: !list.length };
  });
}
