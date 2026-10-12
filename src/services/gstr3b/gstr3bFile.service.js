// src/services/gstr3b/gstr3bFile.service.js
//
// GSTR-3B on the portal, after "Prepare":
//   check    GET /gstr3b/autoliab + POST /gstr3b/validateautocalculatedata
//   save     PUT /gstr3b/retsave (+ /gstr/retstatus)   PREPARED -> SAVE_PENDING -> SAVED
//   plan     GET /gstr3b/retsum + GET /ledgers/bal: ITC use, cash, shortfall
//   offset   PUT /gstr3b/retoffset, then the final retsum -> OFFSET_PENDING -> READY_TO_FILE
//   file     EVC OTP (form R3B) + POST /gstr3b/retevcfile    -> FILING -> FILED
//
// Payment rules: reverse-charge tax, interest and late fee are paid in cash
// only; other tax uses ITC first (sections 49 / 49A / 49B, rule 88A — see
// setOffLiability). Credit available = credit ledger balance + this
// return's net ITC (4C), as on the portal's offset screen.

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import * as whitebooks from "../whitebooks.service.js";
import { getActiveGstSession } from "../gstAuth.service.js";
import { collectPortalErrors } from "../gstr1/gstr1Save.service.js";
import { setOffLiability } from "./gstr3bBuilder.js";
import { getGstr3bRun } from "./gstr3b.service.js";

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const HEADS = ["igst", "cgst", "sgst", "cess"];
const SHORT = { igst: "iamt", cgst: "camt", sgst: "samt", cess: "csamt" };

function httpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function portalContext({ companyId, gstin, ipAddress }) {
  const session = await getActiveGstSession({ companyId, gstin });
  const config = whitebooks.getWhiteBooksConfig();
  return { gstin, txn: session.txn, gstUsername: session.gstUsername, ipAddress: config.ipAddress || ipAddress, ...config };
}

async function updateRun(companyId, gstin, period, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
  await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_gstr3b_runs SET ${sets}, updated_at = now() WHERE company_id = $1 AND gstin = $2 AND return_period = $3`,
    [companyId, gstin, period, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]
  );
}

async function claimStage(companyId, gstin, period, from, to) {
  const { rowCount } = await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_gstr3b_runs SET stage = $5, updated_at = now()
     WHERE company_id = $1 AND gstin = $2 AND return_period = $3 AND stage = ANY($4)`,
    [companyId, gstin, period, from, to]
  );
  return rowCount === 1;
}

async function requireRun(args) {
  const run = await getGstr3bRun(args);
  if (!run) throw httpError(404, "Prepare GSTR-3B for this period first");
  return run;
}

/* ---------------- check against the portal ---------------- */

/** Pull { txval, iamt, camt, samt, csamt } out of the portal's auto-calculated 3B, whatever its nesting. */
function autoFigures(auto) {
  const pick = (o) => (o ? { txval: num(o.txval), iamt: num(o.iamt), camt: num(o.camt), samt: num(o.samt), csamt: num(o.csamt) } : null);
  const lia = auto?.r3bautopop?.liabitc || auto?.liabitc || auto;
  const sup = lia?.sup_details || {};
  const out = pick(sup.osup_det?.subtotal || sup.osup_det || sup.osup_3_1a?.subtotal);
  const rcm = pick(sup.isup_rev?.subtotal || sup.isup_rev || sup.isup_3_1d?.subtotal);
  const itcList = lia?.itc_elg?.itc_avl || [];
  const oth = Array.isArray(itcList) ? itcList.find((x) => x.ty === "OTH") : null;
  const itc = pick(oth || lia?.elgitc?.itc4a5?.subtotal);
  return { out, rcm, itc };
}

/**
 * Compare the prepared 3B with the portal's auto-calculated values and get
 * GSTN's own verdict. Differences are shown, not blocking — but saving
 * needs them acknowledged.
 */
export async function checkGstr3bOnPortal({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (!["PREPARED", "SAVE_FAILED", "SAVED"].includes(run.stage)) throw httpError(409, `GSTR-3B for ${period} is at stage ${run.stage}`);
  if (run.stats?.errors) throw httpError(400, `Fix the ${run.stats.errors} blocking issue(s) and prepare again first`);
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const [auto, verdict] = await Promise.all([
    whitebooks.getGstr3bAutoLiability({ ...ctx, retPeriod: run.ret_period, mockBasis: run.payload }),
    whitebooks.validateGstr3bAgainstAuto({ ...ctx, retPeriod: run.ret_period, payload: run.payload }),
  ]);
  const portal = autoFigures(auto);
  const books = {
    out: run.payload.sup_details.osup_det,
    rcm: run.payload.sup_details.isup_rev,
    itc: run.payload.itc_elg.itc_avl.find((x) => x.ty === "OTH"),
  };
  const ROWS = [
    ["out", "3.1(a) Outward taxable supplies", "liability"],
    ["rcm", "3.1(d) Inward supplies under reverse charge", "liability"],
    ["itc", "4(A)(5) All other ITC", "itc"],
  ];
  const rows = ROWS.map(([key, label, kind]) => {
    const b = books[key] || {};
    const p = portal[key];
    if (!p) return { key, label, books: b, portal: null, diffs: {}, match: true, unavailable: true };
    const diffs = {};
    for (const f of ["txval", "iamt", "camt", "samt", "csamt"]) {
      if (key === "itc" && f === "txval") continue;
      const d = r2(num(b[f]) - num(p[f]));
      if (Math.abs(d) > 1) diffs[f] = d;
    }
    const taxDiff = r2(["iamt", "camt", "samt", "csamt"].reduce((a, f) => a + (diffs[f] || 0), 0));
    let risk = null;
    if (kind === "liability" && taxDiff < -1) risk = "Tax declared is lower than the portal's auto-calculated figure — GSTN may ask for an explanation (DRC-01B)";
    if (kind === "itc" && taxDiff > 1) risk = "ITC claimed is more than GSTR-2B allows — GSTN may ask for an explanation (DRC-01C)";
    return { key, label, books: b, portal: p, diffs, match: Object.keys(diffs).length === 0, risk };
  });
  const mismatches = rows.filter((r) => !r.match).length;
  await updateRun(companyId, gstin, period, {
    portal_check: { checkedAt: new Date().toISOString(), rows, mismatches, warnings: verdict.warnings, ok: mismatches === 0 && verdict.ok },
  });
  return getGstr3bRun({ companyId, gstin, period });
}

/* ---------------- save ---------------- */

export async function saveGstr3bToPortal({ companyId, gstin, period, acknowledgeWarnings = false, ipAddress, userId }) {
  const run = await requireRun({ companyId, gstin, period });
  if (!["PREPARED", "SAVE_FAILED", "SAVED"].includes(run.stage)) throw httpError(409, `GSTR-3B for ${period} is at stage ${run.stage} and can't be saved again`);
  if (run.stats?.errors) throw httpError(400, `Fix the ${run.stats.errors} blocking issue(s) and prepare again first`);
  if (!run.portal_check) throw httpError(409, "Check the return against the portal first");
  if (!run.portal_check.ok && !acknowledgeWarnings) {
    throw httpError(409, "The portal's figures differ or GSTN raised warnings — review and acknowledge them to save");
  }
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  if (!(await claimStage(companyId, gstin, period, ["PREPARED", "SAVE_FAILED", "SAVED"], "SAVE_PENDING"))) {
    throw httpError(409, "A save is already in progress for this period");
  }
  const ack = !run.portal_check.ok ? { acknowledgedBy: userId || null, acknowledgedAt: new Date().toISOString() } : {};
  try {
    const { referenceId } = await whitebooks.saveGstr3bData({ ...ctx, retPeriod: run.ret_period, payload: run.payload });
    if (referenceId) {
      await updateRun(companyId, gstin, period, { save_ref_id: referenceId, save_status: { status: "SUBMITTED", referenceId, submittedAt: new Date().toISOString(), ...ack } });
    } else {
      // Saved synchronously.
      await updateRun(companyId, gstin, period, { stage: "SAVED", save_status: { status: "SAVED", savedAt: new Date().toISOString(), ...ack } });
    }
  } catch (err) {
    await updateRun(companyId, gstin, period, { stage: "SAVE_FAILED", save_status: { status: "SUBMIT_FAILED", message: err.message, failedAt: new Date().toISOString() } });
    throw err;
  }
  return getGstr3bRun({ companyId, gstin, period });
}

export async function checkGstr3bSaveStatus({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "SAVE_PENDING") return run;
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { statusCode, errorReport } = await whitebooks.getReturnStatus({ ...ctx, retPeriod: run.ret_period, referenceId: run.save_ref_id });
  const prev = run.save_status || {};
  const checkedAt = new Date().toISOString();
  if (!statusCode || statusCode === "IP" || statusCode === "REC") {
    await updateRun(companyId, gstin, period, { save_status: { ...prev, status: "PROCESSING", portalStatus: statusCode, checkedAt } });
  } else if (statusCode === "P") {
    await updateRun(companyId, gstin, period, { stage: "SAVED", offset_plan: null, save_status: { ...prev, status: "SAVED", portalStatus: statusCode, savedAt: checkedAt } });
  } else {
    await updateRun(companyId, gstin, period, { stage: "SAVE_FAILED", save_status: { ...prev, status: "REJECTED", portalStatus: statusCode, errors: collectPortalErrors(errorReport), checkedAt } });
  }
  return getGstr3bRun({ companyId, gstin, period });
}

/* ---------------- plan the payment ---------------- */

/** Liability per ledger from retsum's tx_pmt.tx_py (tax / interest / fee per head). */
function liabilitiesOf(summary) {
  const list = summary?.tx_pmt?.tx_py || [];
  return list.map((t) => ({
    transTyp: Number(t.trans_typ),
    ledgerId: t.liab_ldg_id,
    desc: t.trans_desc || null,
    tax: Object.fromEntries(HEADS.map((h) => [h, num(t[h]?.tx)])),
    interest: Object.fromEntries(HEADS.map((h) => [h, num(t[h]?.intr)])),
    fee: { cgst: num(t.cgst?.fee), sgst: num(t.sgst?.fee) },
  }));
}

/**
 * Work out the payment from the portal's liability and ledger balances.
 * Pure: (summary, balances, netItc) -> plan with the retoffset body.
 */
export function planOffset(summary, balances, netItc) {
  const liabs = liabilitiesOf(summary);
  const other = liabs.find((l) => l.transTyp === 30002) || { transTyp: 30002, ledgerId: null, tax: {}, interest: {}, fee: {} };
  const rcm = liabs.find((l) => l.transTyp === 30003) || null;
  const credit = Object.fromEntries(HEADS.map((h) => [h, r2(num(balances.itc[h]) + Math.max(0, num(netItc?.[SHORT[h]])))]));

  // ITC only against "other than reverse charge" tax.
  const set = setOffLiability(
    Object.fromEntries(HEADS.map((h) => [SHORT[h], num(other.tax[h])])),
    Object.fromEntries(HEADS.map((h) => [SHORT[h], credit[h]]))
  );
  const cashTax = { igst: set.cash.ipd, cgst: set.cash.cpd, sgst: set.cash.spd, cess: set.cash.cspd };
  const cashNeeded = Object.fromEntries(HEADS.map((h) => [h, r2(
    cashTax[h] + num(other.interest[h]) + num(other.fee[h]) + (rcm ? num(rcm.tax[h]) + num(rcm.interest[h]) : 0)
  )]));
  const shortfall = Object.fromEntries(HEADS.map((h) => [h, r2(Math.max(0, cashNeeded[h] - num(balances.cash[h])))]));
  const shortfallTotal = r2(HEADS.reduce((a, h) => a + shortfall[h], 0));
  const totalPayable = r2(liabs.reduce((a, l) => a + HEADS.reduce((x, h) => x + l.tax[h] + l.interest[h], 0) + num(l.fee.cgst) + num(l.fee.sgst), 0));

  const pdcash = [{
    liab_ldg_id: other.ledgerId, trans_typ: 30002,
    ipd: cashTax.igst, cpd: cashTax.cgst, spd: cashTax.sgst, cspd: cashTax.cess,
    i_intrpd: num(other.interest.igst), c_intrpd: num(other.interest.cgst), s_intrpd: num(other.interest.sgst), cs_intrpd: num(other.interest.cess),
    c_lfeepd: num(other.fee.cgst), s_lfeepd: num(other.fee.sgst),
  }];
  if (rcm && HEADS.some((h) => rcm.tax[h] || rcm.interest[h])) {
    pdcash.push({
      liab_ldg_id: rcm.ledgerId, trans_typ: 30003,
      ipd: rcm.tax.igst, cpd: rcm.tax.cgst, spd: rcm.tax.sgst, cspd: rcm.tax.cess,
      i_intrpd: rcm.interest.igst, c_intrpd: rcm.interest.cgst, s_intrpd: rcm.interest.sgst, cs_intrpd: rcm.interest.cess,
      c_lfeepd: 0, s_lfeepd: 0,
    });
  }
  const body = { pdcash, pditc: { liab_ldg_id: other.ledgerId, trans_typ: 30002, ...set.paidByItc } };

  return {
    liabilities: liabs,
    credit,
    itcUse: set.paidByItc,
    cashNeeded,
    cashBalance: balances.cash,
    shortfall,
    shortfallTotal,
    totalPayable,
    nothingToPay: totalPayable === 0,
    missingLedger: !other.ledgerId && totalPayable > 0,
    body,
  };
}

export async function planGstr3bPayment({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (!["SAVED", "OFFSET_FAILED"].includes(run.stage)) throw httpError(409, "Save GSTR-3B on the portal first");
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const [summary, balances] = await Promise.all([
    whitebooks.getGstr3bSummary({ ...ctx, retPeriod: run.ret_period }),
    whitebooks.getLedgerBalances({ ...ctx, retPeriod: run.ret_period }),
  ]);
  const plan = planOffset(summary, balances, run.payload.itc_elg.itc_net);
  await updateRun(companyId, gstin, period, {
    portal_summary: summary,
    ledger_balance: { itc: balances.itc, cash: balances.cash, readAt: new Date().toISOString() },
    offset_plan: { ...plan, plannedAt: new Date().toISOString() },
  });
  return getGstr3bRun({ companyId, gstin, period });
}

/* ---------------- offset ---------------- */

/**
 * Pay the liability. The plan is recalculated from fresh balances first;
 * a cash shortfall blocks (pay it by challan, then try again).
 */
export async function offsetGstr3b({ companyId, gstin, period, ipAddress }) {
  let run = await planGstr3bPayment({ companyId, gstin, period, ipAddress });
  const plan = run.offset_plan;
  if (plan.missingLedger) throw httpError(409, "The portal's summary has no liability ledger id — save GSTR-3B again and retry");
  if (plan.shortfallTotal > 0) {
    throw httpError(409, `Electronic cash ledger is short by ₹${plan.shortfallTotal.toLocaleString("en-IN")} — pay it by challan (PMT-06), then try again`);
  }
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  if (!(await claimStage(companyId, gstin, period, ["SAVED", "OFFSET_FAILED"], "OFFSET_PENDING"))) {
    throw httpError(409, "Offset is already in progress for this period");
  }
  try {
    if (!plan.nothingToPay) await whitebooks.offsetGstr3bLiability({ ...ctx, retPeriod: run.ret_period, body: plan.body });
    await updateRun(companyId, gstin, period, { offset_status: { status: plan.nothingToPay ? "NOT_NEEDED" : "SUBMITTED", at: new Date().toISOString(), body: plan.body } });
  } catch (err) {
    await updateRun(companyId, gstin, period, { stage: "OFFSET_FAILED", offset_status: { status: "FAILED", message: err.message, at: new Date().toISOString() } });
    if (err.details?.status_cd === "0" || err.details?.error) throw httpError(400, err.message.replace(/^WhiteBooks: /, ""));
    throw err;
  }
  return confirmOffset({ companyId, gstin, period, ipAddress });
}

/** Fetch the final summary: it records the payment and is the filing body. */
export async function confirmOffset({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "OFFSET_PENDING") return run;
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const summary = await whitebooks.getGstr3bSummary({ ...ctx, retPeriod: run.ret_period });
  const recorded = run.offset_status?.status === "NOT_NEEDED" || !!(summary?.tx_pmt?.pdcash || summary?.tx_pmt?.pditc);
  await updateRun(companyId, gstin, period, {
    final_summary: summary,
    ...(recorded ? { stage: "READY_TO_FILE", offset_status: { ...run.offset_status, status: run.offset_status?.status === "NOT_NEEDED" ? "NOT_NEEDED" : "DONE", confirmedAt: new Date().toISOString() } } : {}),
  });
  return getGstr3bRun({ companyId, gstin, period });
}

/* ---------------- EVC OTP + file ---------------- */

function cleanPan(pan) {
  const p = String(pan || "").trim().toUpperCase();
  if (!PAN_RE.test(p)) throw httpError(400, "Enter the authorised signatory's PAN (10 characters, e.g. ABCDE1234F)");
  return p;
}

export async function sendGstr3bOtp({ companyId, gstin, period, pan, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "READY_TO_FILE") throw httpError(409, "Offset the liability first — the OTP can only be used once the return is ready to file");
  const signatoryPan = cleanPan(pan);
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  await whitebooks.requestEvcOtp({ ...ctx, pan: signatoryPan, formType: "R3B" });
  await pool.query(`UPDATE ${DB_SCHEMA}.gst_credentials SET signatory_pan = $3, updated_at = now() WHERE company_id = $1 AND gstin = $2`, [companyId, gstin, signatoryPan]);
  await updateRun(companyId, gstin, period, { file_status: { ...(run.file_status || {}), otpSentAt: new Date().toISOString(), pan: signatoryPan } });
  return getGstr3bRun({ companyId, gstin, period });
}

export async function fileGstr3b({ companyId, gstin, period, pan, evcOtp, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage === "FILED") throw httpError(409, `GSTR-3B for ${period} is already filed (ARN ${run.arn})`);
  if (run.stage !== "READY_TO_FILE") throw httpError(409, "Offset the liability first");
  if (!/^\d{6}$/.test(String(evcOtp || ""))) throw httpError(400, "Enter the 6-digit EVC OTP");
  const signatoryPan = cleanPan(pan || run.file_status?.pan);
  if (!run.final_summary) throw httpError(409, "The final portal summary is missing — offset again");
  if (!(await claimStage(companyId, gstin, period, ["READY_TO_FILE"], "FILING"))) throw httpError(409, "Filing is already in progress for this period");

  try {
    const ctx = await portalContext({ companyId, gstin, ipAddress });
    const { arn } = await whitebooks.fileGstr3bWithEvc({ ...ctx, retPeriod: run.ret_period, pan: signatoryPan, evcOtp: String(evcOtp), body: run.final_summary });
    await updateRun(companyId, gstin, period, {
      stage: "FILED", arn, filed_at: new Date().toISOString(),
      file_status: { ...(run.file_status || {}), status: "FILED", arn, filedAt: new Date().toISOString(), pan: signatoryPan },
    });
  } catch (err) {
    const stage = err.uncertain ? "FILING" : "READY_TO_FILE";
    await updateRun(companyId, gstin, period, { stage, file_status: { ...(run.file_status || {}), status: err.uncertain ? "UNCERTAIN" : "FAILED", message: err.message, failedAt: new Date().toISOString() } });
    if (err.details?.status_cd === "0" || err.details?.error) throw httpError(400, err.message.replace(/^WhiteBooks: /, ""));
    throw err;
  }
  return getGstr3bRun({ companyId, gstin, period });
}

