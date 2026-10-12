// src/services/ims/imsPortal.service.js
//
// IMS step, part 2: send the accept / reject / pending actions to the GST
// portal (PUT /ims/save, then GET /ims/status), regenerate GSTR-2B so it
// reflects them (PUT /gstr2b/gen2b, then GET /gstr2b/get2b), and verify the
// generated 2B against the ITC accepted here (GET /gstr2b/all).
//
// Run stages: FETCHED -> SAVE_PENDING -> SAVED | SAVE_FAILED
//             -> GEN2B_PENDING -> GSTR2B_GENERATED (differences) | VERIFIED
//
// GSTN treats an invoice left with no action ("N") as accepted when 2B is
// generated — so every invoice whose action differs from the portal's is
// sent, pending ones included.

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import * as whitebooks from "../whitebooks.service.js";
import { getActiveGstSession } from "../gstAuth.service.js";
import { collectPortalErrors } from "../gstr1/gstr1Save.service.js";
import { getImsRun, finalAction } from "./ims.service.js";

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const HEADS = ["igst", "cgst", "sgst", "cess"];
const BUSY = ["SAVE_PENDING", "GEN2B_PENDING"];

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
    `UPDATE ${DB_SCHEMA}.gst_ims_runs SET ${sets}, updated_at = now() WHERE company_id = $1 AND gstin = $2 AND return_period = $3`,
    [companyId, gstin, period, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]
  );
}

async function claimStage(companyId, gstin, period, from, to) {
  const { rowCount } = await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_ims_runs SET stage = $5, updated_at = now()
     WHERE company_id = $1 AND gstin = $2 AND return_period = $3 AND stage = ANY($4)`,
    [companyId, gstin, period, from, to]
  );
  return rowCount === 1;
}

/** IMS actions for a period are final once its GSTR-3B is filed. */
export async function assertImsOpen({ companyId, gstin, period }) {
  const { rows } = await pool.query(
    `SELECT stage FROM ${DB_SCHEMA}.gst_gstr3b_runs WHERE company_id = $1 AND gstin = $2 AND return_period = $3`,
    [companyId, gstin, period]
  );
  if (rows[0]?.stage === "FILED") throw httpError(409, `GSTR-3B for ${period} is filed — IMS actions for it can't change any more`);
}

async function requireRun(args) {
  const run = await getImsRun(args);
  if (!run) throw httpError(404, "Fetch IMS invoices for this period first");
  return run;
}

/** Rows of the period whose action has to be sent (differs from the portal's). */
export function changedRecords(run) {
  return run.rows
    .filter((r) => r.inPeriod)
    .map((r) => ({ row: r, action: finalAction(r, run.decisions) }))
    .filter(({ row, action }) => action && action !== row.portalAction);
}

/* ---------------- save actions ---------------- */

export async function saveImsToPortal({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  await assertImsOpen({ companyId, gstin, period });
  if (BUSY.includes(run.stage)) throw httpError(409, "A save or 2B generation is already in progress for this period");
  if (run.stats?.undecided) throw httpError(400, `${run.stats.undecided} invoice(s) still need an accept / reject decision`);

  const changes = changedRecords(run);
  if (changes.some(({ row }) => !row.src?.hash)) {
    throw httpError(409, "These IMS invoices were fetched before the portal record was kept — fetch IMS again, then save");
  }
  if (!changes.length) {
    // Portal already shows every action: nothing to send.
    await updateRun(companyId, gstin, period, { stage: "SAVED", save_status: { status: "NOTHING_TO_SEND", savedAt: new Date().toISOString(), sent: 0 } });
    return getImsRun({ companyId, gstin, period });
  }

  const ctx = await portalContext({ companyId, gstin, ipAddress });
  if (!(await claimStage(companyId, gstin, period, ["FETCHED", "SAVED", "SAVE_FAILED", "GSTR2B_GENERATED", "VERIFIED"], "SAVE_PENDING"))) {
    throw httpError(409, "A save is already in progress for this period");
  }
  try {
    const { referenceId } = await whitebooks.saveImsActions({
      ...ctx, retPeriod: run.ret_period,
      records: changes.map(({ row, action }) => ({ section: row.section, src: row.src, action })),
    });
    await updateRun(companyId, gstin, period, {
      save_ref_id: referenceId,
      save_status: {
        status: "SUBMITTED", referenceId, submittedAt: new Date().toISOString(),
        sent: changes.length, sentKeys: changes.map(({ row, action }) => ({ key: row.key, action })),
      },
    });
  } catch (err) {
    await updateRun(companyId, gstin, period, { stage: "SAVE_FAILED", save_status: { status: "SUBMIT_FAILED", message: err.message, failedAt: new Date().toISOString() } });
    throw err;
  }
  return getImsRun({ companyId, gstin, period });
}

/** Follow the IMS save; on success the rows' portal action is updated. */
export async function checkImsSaveStatus({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "SAVE_PENDING") return run;
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { statusCode, errorReport } = await whitebooks.getImsStatus({ ...ctx, referenceId: run.save_ref_id });
  const prev = run.save_status || {};
  const checkedAt = new Date().toISOString();

  if (!statusCode || statusCode === "IP" || statusCode === "REC") {
    await updateRun(companyId, gstin, period, { save_status: { ...prev, status: "PROCESSING", portalStatus: statusCode, checkedAt } });
    return getImsRun({ companyId, gstin, period });
  }

  const errors = statusCode === "P" ? [] : collectPortalErrors(errorReport);
  const failedDocs = new Set(errors.map((e) => String(e.doc)));
  // P: everything applied. PE: everything except the listed records. ER: nothing.
  const applied = statusCode === "ER" ? new Map() : new Map((prev.sentKeys || []).map((s) => [s.key, s.action]));
  const rows = run.rows.map((r) => (applied.has(r.key) && !failedDocs.has(String(r.inum)) ? { ...r, portalAction: applied.get(r.key) } : r));
  await updateRun(companyId, gstin, period, {
    rows,
    stage: statusCode === "P" ? "SAVED" : "SAVE_FAILED",
    save_status: {
      ...prev, sentKeys: undefined,
      status: statusCode === "P" ? "SAVED" : "REJECTED",
      portalStatus: statusCode, partial: statusCode === "PE", errors, checkedAt,
      ...(statusCode === "P" ? { savedAt: checkedAt } : {}),
    },
  });
  return getImsRun({ companyId, gstin, period });
}

/* ---------------- generate + verify GSTR-2B ---------------- */

export async function generateGstr2b({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  await assertImsOpen({ companyId, gstin, period });
  if (!["SAVED", "GSTR2B_GENERATED", "VERIFIED"].includes(run.stage)) {
    throw httpError(409, run.stage === "SAVE_PENDING" || run.stage === "GEN2B_PENDING"
      ? "Wait for the current request to finish"
      : "Save the IMS actions to the portal first — 2B only reflects saved actions");
  }
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  if (!(await claimStage(companyId, gstin, period, ["SAVED", "GSTR2B_GENERATED", "VERIFIED"], "GEN2B_PENDING"))) {
    throw httpError(409, "GSTR-2B generation is already in progress");
  }
  try {
    const { referenceId } = await whitebooks.generate2b({ ...ctx, retPeriod: run.ret_period });
    await updateRun(companyId, gstin, period, {
      gen2b_ref_id: referenceId,
      gen2b_status: { status: "SUBMITTED", referenceId, submittedAt: new Date().toISOString() },
    });
  } catch (err) {
    // Back to SAVED: the actions are on the portal; generation can be retried
    // (GSTN only allows on-demand 2B once the period's 2B exists — after the 14th).
    await updateRun(companyId, gstin, period, { stage: "SAVED", gen2b_status: { status: "SUBMIT_FAILED", message: err.message, failedAt: new Date().toISOString() } });
    if (err.details?.status_cd === "0" || err.details?.error) throw httpError(400, err.message.replace(/^WhiteBooks: /, ""));
    throw err;
  }
  return getImsRun({ companyId, gstin, period });
}

/**
 * Compare GSTR-2B's ITC with the ITC accepted in IMS for the period:
 * invoices / debit notes against 2B's non-reverse-charge ITC, supplier
 * credit notes against 2B's credit-note section. ₹1 per head tolerated.
 */
export function compare2b(run, gstr2b) {
  const accepted = { invoices: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, creditNotes: { igst: 0, cgst: 0, sgst: 0, cess: 0 } };
  let acceptedCount = 0;
  for (const r of run.rows) {
    if (!r.inPeriod || finalAction(r, run.decisions) !== "A") continue;
    acceptedCount += 1;
    const t = /CN/.test(r.section) ? accepted.creditNotes : accepted.invoices;
    t.igst += num(r.iamt); t.cgst += num(r.camt); t.sgst += num(r.samt); t.cess += num(r.cess);
  }
  const avl = gstr2b?.itcsumm?.itcavl || {};
  const pick = (o) => Object.fromEntries(HEADS.map((h) => [h, r2(num(o?.[h]))]));
  const nonrev = pick(avl.nonrevsup);
  const cn = pick(avl.othersup?.cdnr || avl.othersup);
  const rows = [
    { key: "invoices", label: "Invoices and debit notes (4A(5))", books: pick(accepted.invoices), gstr2b: nonrev },
    { key: "creditNotes", label: "Supplier credit notes (reduce ITC)", books: pick(accepted.creditNotes), gstr2b: cn },
  ].map((row) => {
    const diffs = Object.fromEntries(HEADS.map((h) => [h, r2(row.gstr2b[h] - row.books[h])]).filter(([, d]) => Math.abs(d) > 1));
    return { ...row, diffs, match: Object.keys(diffs).length === 0 };
  });
  const info = {
    reverseCharge: pick(avl.revsup), // ITC on RCM purchases — claimed in 3B 4A(3)
    imports: pick(avl.imports || avl.impg),
    rejected: pick(gstr2b?.itcsumm?.itcrej?.nonrevsup),
    acceptedCount,
  };
  return { rows, info, mismatches: rows.filter((r) => !r.match).length, generatedOn: gstr2b?.gendt || null };
}

async function fetchAndVerify({ companyId, gstin, period, run, ctx, acceptDifferences = false, userId = null }) {
  const gstr2b = await whitebooks.getGstr2b({ ...ctx, retPeriod: run.ret_period });
  const verification = compare2b(run, gstr2b);
  const verified = verification.mismatches === 0 || acceptDifferences;
  await updateRun(companyId, gstin, period, {
    stage: verified ? "VERIFIED" : "GSTR2B_GENERATED",
    gstr2b: {
      itcsumm: gstr2b.itcsumm, gendt: gstr2b.gendt || null,
      cpsumm: gstr2b.cpsumm || null,
      verification,
      ...(acceptDifferences && verification.mismatches ? { acceptedDifferences: { by: userId, at: new Date().toISOString() } } : {}),
    },
    verified_at: verified ? new Date().toISOString() : null,
  });
  return getImsRun({ companyId, gstin, period });
}

/** Follow 2B generation; once done, fetch 2B and verify it. */
export async function check2bStatus({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "GEN2B_PENDING") return run;
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { statusCode, errorReport } = await whitebooks.get2bStatus({ ...ctx, referenceId: run.gen2b_ref_id });
  const prev = run.gen2b_status || {};
  const checkedAt = new Date().toISOString();
  if (!statusCode || statusCode === "IP" || statusCode === "REC") {
    await updateRun(companyId, gstin, period, { gen2b_status: { ...prev, status: "PROCESSING", portalStatus: statusCode, checkedAt } });
    return getImsRun({ companyId, gstin, period });
  }
  if (statusCode !== "P") {
    await updateRun(companyId, gstin, period, {
      stage: "SAVED",
      gen2b_status: { ...prev, status: "FAILED", portalStatus: statusCode, errors: collectPortalErrors(errorReport), checkedAt },
    });
    return getImsRun({ companyId, gstin, period });
  }
  await updateRun(companyId, gstin, period, { gen2b_status: { ...prev, status: "GENERATED", portalStatus: statusCode, generatedAt: checkedAt } });
  return fetchAndVerify({ companyId, gstin, period, run, ctx });
}

/**
 * Re-read 2B and verify again; with acceptDifferences the user takes 2B's
 * figures as final (2B is what GSTR-3B's ITC is checked against).
 */
export async function verifyGstr2b({ companyId, gstin, period, acceptDifferences = false, ipAddress, userId }) {
  const run = await requireRun({ companyId, gstin, period });
  if (!["GSTR2B_GENERATED", "VERIFIED"].includes(run.stage)) throw httpError(409, "Generate GSTR-2B first");
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  return fetchAndVerify({ companyId, gstin, period, run, ctx, acceptDifferences, userId });
}
