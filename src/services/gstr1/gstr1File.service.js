// src/services/gstr1/gstr1File.service.js
//
// GSTR-1 stages 3–9, after the return is saved on the portal:
//   validate   GET /gstr1/validatehsnsum + GET /gstr1/retsum (long) compared
//              with what we saved                         SAVED -> VALIDATED
//   proceed    GET /all/newproceedfile, then /all/newretstatus
//                                     -> PROCEED_PENDING -> READY_TO_FILE
//              (on success the final short summary is fetched: it is the
//               body of the filing call)
//   EVC OTP    GET /authentication/otpforevc (form_type R1)
//   file       POST /gstr1/retevcfile           -> FILING -> FILED (ARN)
// A nil return skips save/validate: PREPARED (nil) -> proceed with isNil=Y.

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import * as whitebooks from "../whitebooks.service.js";
import { getActiveGstSession } from "../gstAuth.service.js";
import { getRun } from "./gstr1Prepare.service.js";
import { compareSummary } from "./gstr1Summary.js";
import { collectPortalErrors } from "./gstr1Save.service.js";

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

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
    `UPDATE ${DB_SCHEMA}.gst_gstr1_runs SET ${sets}, updated_at = now() WHERE company_id = $1 AND gstin = $2 AND return_period = $3`,
    [companyId, gstin, period, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]
  );
}

/** Move the run from one of `from` to `to` atomically; false if someone else got there first. */
async function claimStage(companyId, gstin, period, from, to) {
  const { rowCount } = await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_gstr1_runs SET stage = $5, updated_at = now()
     WHERE company_id = $1 AND gstin = $2 AND return_period = $3 AND stage = ANY($4)`,
    [companyId, gstin, period, from, to]
  );
  return rowCount === 1;
}

async function requireRun(args) {
  const run = await getRun(args);
  if (!run) throw httpError(404, "Prepare GSTR-1 for this period first");
  return run;
}

/* ---------------- stage 3–5: validate on the portal ---------------- */

/**
 * HSN validation + portal summary vs what we saved. VALIDATED only when
 * both pass; otherwise the run stays SAVED with the findings attached.
 */
export async function validateOnPortal({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (!["SAVED", "VALIDATED"].includes(run.stage)) {
    throw httpError(409, run.stage === "PREPARED" || run.stage === "SAVE_FAILED"
      ? "Save the return to the GST portal before validating it"
      : `GSTR-1 for ${period} is at stage ${run.stage}`);
  }
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const hsn = await whitebooks.validateHsnSummary({ ...ctx, retPeriod: run.ret_period });
  const portal = await whitebooks.getGstr1Summary({ ...ctx, retPeriod: run.ret_period, longSummary: true });
  const summary = compareSummary(run.payload, portal.sec_sum);

  const ok = hsn.valid && summary.mismatches === 0;
  await updateRun(companyId, gstin, period, {
    stage: ok ? "VALIDATED" : "SAVED",
    validation: {
      checkedAt: new Date().toISOString(),
      hsn: { valid: hsn.valid, errors: hsn.errors },
      summary: { rows: summary.rows, mismatches: summary.mismatches },
      ok,
    },
  });
  return getRun({ companyId, gstin, period });
}

/* ---------------- stage 6: proceed to file ---------------- */

/**
 * Freeze the return for filing. Regular return: needs VALIDATED, or SAVED
 * with a passing HSN check and acceptDifferences (the user saw the summary
 * differences and accepts the portal's figures). Nil return: from PREPARED.
 */
export async function proceedToFile({ companyId, gstin, period, acceptDifferences = false, ipAddress, userId }) {
  const run = await requireRun({ companyId, gstin, period });
  const isNil = !!run.stats?.isNil;
  let from;
  if (isNil) {
    if (run.save_status?.status === "SAVED") {
      throw httpError(409, "Data saved earlier is still on the portal — reset the portal data before filing a nil return");
    }
    from = ["PREPARED", "PROCEED_FAILED"];
  } else if (run.stage === "VALIDATED" || run.stage === "PROCEED_FAILED") {
    from = ["VALIDATED", "PROCEED_FAILED"];
  } else if (run.stage === "SAVED") {
    if (!run.validation) throw httpError(409, "Validate the return on the portal before proceeding to file");
    if (!run.validation.hsn?.valid) throw httpError(409, "The HSN summary failed GSTN's validation — fix it, save and validate again");
    if (!acceptDifferences) throw httpError(409, `The portal summary differs from your books in ${run.validation.summary.mismatches} section(s) — review and accept the differences to continue`);
    from = ["SAVED"];
  } else {
    throw httpError(409, `GSTR-1 for ${period} is at stage ${run.stage} — it can't proceed to file now`);
  }
  if (!(await claimStage(companyId, gstin, period, from, "PROCEED_PENDING"))) {
    throw httpError(409, "Proceed to file is already in progress for this period");
  }

  try {
    const ctx = await portalContext({ companyId, gstin, ipAddress });
    const { referenceId } = await whitebooks.proceedToFile({ ...ctx, retPeriod: run.ret_period, isNil });
    await updateRun(companyId, gstin, period, {
      proceed_ref_id: referenceId,
      proceed_status: {
        status: "SUBMITTED", referenceId, isNil, submittedAt: new Date().toISOString(),
        ...(acceptDifferences && !isNil && run.stage === "SAVED" ? { acceptedDifferences: { by: userId || null, at: new Date().toISOString(), mismatches: run.validation.summary.mismatches } } : {}),
      },
    });
  } catch (err) {
    await updateRun(companyId, gstin, period, { stage: "PROCEED_FAILED", proceed_status: { status: "SUBMIT_FAILED", message: err.message, failedAt: new Date().toISOString() } });
    throw err;
  }
  return getRun({ companyId, gstin, period });
}

/**
 * Follow the proceed-to-file request. On success, fetch the final summary
 * (its data object is the filing body) and move to READY_TO_FILE.
 */
export async function checkProceedStatus({ companyId, gstin, period, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "PROCEED_PENDING") return run;
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { statusCode, errorReport } = await whitebooks.getNewReturnStatus({ ...ctx, retPeriod: run.ret_period, referenceId: run.proceed_ref_id });
  const prev = run.proceed_status || {};
  const checkedAt = new Date().toISOString();

  if (!statusCode || statusCode === "IP" || statusCode === "REC") {
    await updateRun(companyId, gstin, period, { proceed_status: { ...prev, status: "PROCESSING", portalStatus: statusCode, checkedAt } });
    return getRun({ companyId, gstin, period });
  }
  if (statusCode !== "P") {
    await updateRun(companyId, gstin, period, {
      stage: "PROCEED_FAILED",
      proceed_status: { ...prev, status: "REJECTED", portalStatus: statusCode, errors: collectPortalErrors(errorReport), checkedAt },
    });
    return getRun({ companyId, gstin, period });
  }

  const finalSummary = prev.isNil ? null : await whitebooks.getGstr1Summary({ ...ctx, retPeriod: run.ret_period });
  await updateRun(companyId, gstin, period, {
    stage: "READY_TO_FILE",
    proceed_status: { ...prev, status: "PROCEEDED", portalStatus: statusCode, checkedAt },
    final_summary: finalSummary,
  });
  return getRun({ companyId, gstin, period });
}

/* ---------------- stage 7–9: EVC OTP and filing ---------------- */

function cleanPan(pan) {
  const p = String(pan || "").trim().toUpperCase();
  if (!PAN_RE.test(p)) throw httpError(400, "Enter the authorised signatory's PAN (10 characters, e.g. ABCDE1234F)");
  return p;
}

/** Send the EVC OTP to the authorised signatory; remembers the PAN for this GSTIN. */
export async function sendFilingOtp({ companyId, gstin, period, pan, ipAddress }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage !== "READY_TO_FILE") throw httpError(409, "Proceed to file first — the OTP can only be used once the return is ready to file");
  const signatoryPan = cleanPan(pan);
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  await whitebooks.requestEvcOtp({ ...ctx, pan: signatoryPan, formType: "R1" });
  await pool.query(`UPDATE ${DB_SCHEMA}.gst_credentials SET signatory_pan = $3, updated_at = now() WHERE company_id = $1 AND gstin = $2`, [companyId, gstin, signatoryPan]);
  await updateRun(companyId, gstin, period, { file_status: { ...(run.file_status || {}), otpSentAt: new Date().toISOString(), pan: signatoryPan } });
  return getRun({ companyId, gstin, period });
}

/**
 * File with the EVC OTP. A rejected OTP leaves the run READY_TO_FILE so the
 * user can retry; an unclear outcome is flagged so nobody files twice.
 */
export async function fileGstr1({ companyId, gstin, period, pan, evcOtp, ipAddress, userId }) {
  const run = await requireRun({ companyId, gstin, period });
  if (run.stage === "FILED") throw httpError(409, `GSTR-1 for ${period} is already filed (ARN ${run.arn})`);
  if (run.stage !== "READY_TO_FILE") throw httpError(409, "Proceed to file first");
  if (!/^\d{6}$/.test(String(evcOtp || ""))) throw httpError(400, "Enter the 6-digit EVC OTP");
  const signatoryPan = cleanPan(pan || run.file_status?.pan);
  const isNil = !!run.proceed_status?.isNil;
  if (!isNil && !run.final_summary) throw httpError(409, "The final portal summary is missing — proceed to file again");

  if (!(await claimStage(companyId, gstin, period, ["READY_TO_FILE"], "FILING"))) {
    throw httpError(409, "Filing is already in progress for this period");
  }
  const { rows: [audit] } = await pool.query(
    `INSERT INTO ${DB_SCHEMA}.gst_gstr1_filings
       (company_id, gstin, financial_year, return_period, status, payload_hash, invoice_count, requested_at, created_by)
     VALUES ($1,$2,$3,$4,'FILE_PENDING',$5,$6,now(),$7) RETURNING id`,
    [companyId, gstin, run.financial_year, period, run.payload_hash, run.stats?.invoicesIncluded ?? null, userId || null]
  );

  const body = isNil ? { gstin, ret_period: run.ret_period, isnil: "Y" } : run.final_summary;
  try {
    const ctx = await portalContext({ companyId, gstin, ipAddress });
    const { arn, raw } = await whitebooks.fileGstr1WithEvc({ ...ctx, retPeriod: run.ret_period, pan: signatoryPan, evcOtp: String(evcOtp), body });
    await updateRun(companyId, gstin, period, {
      stage: "FILED",
      arn,
      filed_at: new Date().toISOString(),
      file_status: { ...(run.file_status || {}), status: "FILED", arn, filedAt: new Date().toISOString(), pan: signatoryPan },
    });
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_gstr1_filings SET status = 'FILED', arn = $2, response_payload = $3, responded_at = now(), updated_at = now() WHERE id = $1`,
      [audit.id, arn, JSON.stringify(raw)]
    );
  } catch (err) {
    // Unclear outcome (no ARN in a success response): don't let a retry file twice.
    const stage = err.uncertain ? "FILING" : "READY_TO_FILE";
    await updateRun(companyId, gstin, period, {
      stage,
      file_status: { ...(run.file_status || {}), status: err.uncertain ? "UNCERTAIN" : "FAILED", message: err.message, failedAt: new Date().toISOString() },
    });
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_gstr1_filings SET status = 'FILE_FAILED', error_response = $2, responded_at = now(), updated_at = now() WHERE id = $1`,
      [audit.id, JSON.stringify(err.details || { message: err.message })]
    );
    if (err.details?.status_cd === "0" || err.details?.error) throw httpError(400, err.message.replace(/^WhiteBooks: /, ""));
    throw err;
  }
  return getRun({ companyId, gstin, period });
}
