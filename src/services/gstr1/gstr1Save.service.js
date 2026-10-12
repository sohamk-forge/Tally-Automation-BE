// src/services/gstr1/gstr1Save.service.js
//
// Stage 2 of the GSTR-1 pipeline: upload the prepared return to the GST
// portal (WhiteBooks PUT /gstr1/retsave), follow GSTN's asynchronous
// processing (GET /gstr/retstatus), and reset portal data when needed.
//
// Run stages: PREPARED -> SAVE_PENDING -> SAVED | SAVE_FAILED.
// Every submission is also recorded in gst_gstr1_filings (audit trail).

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import * as whitebooks from "../whitebooks.service.js";
import { getActiveGstSession } from "../gstAuth.service.js";
import { getRun } from "./gstr1Prepare.service.js";

const MAX_PAYLOAD_BYTES = 5_000_000; // GSTN's per-request limit
const SAVABLE = ["PREPARED", "SAVE_FAILED", "SAVED", "VALIDATED", "PROCEED_FAILED"];
const STATUS_TEXT = {
  P: "Processed",
  PE: "Processed with errors",
  ER: "Rejected with errors",
  IP: "In progress",
  REC: "Received, waiting to be processed",
};

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

/**
 * Flatten GSTN's error_report (nested by section / ctin / invoice) into
 * [{ section, ctin, doc, hsn, code, message }], whatever its exact nesting.
 */
export function collectPortalErrors(report) {
  const out = [];
  const walk = (node, ctx) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, ctx)); return; }
    if (!node || typeof node !== "object") return;
    const here = { ...ctx };
    if (node.ctin) here.ctin = node.ctin;
    if (node.inum || node.nt_num) here.doc = node.inum || node.nt_num;
    if (node.hsn_sc) here.hsn = node.hsn_sc;
    if (node.error_msg || node.error_cd) {
      out.push({ section: here.section || null, ctin: here.ctin || null, doc: here.doc || null, hsn: here.hsn || null, code: node.error_cd || null, message: node.error_msg || "Rejected by GSTN" });
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v, { ...here, section: here.section || k });
    }
  };
  walk(report, {});
  return out;
}

/** Upload the prepared return. Returns the run (stage SAVE_PENDING). */
export async function saveGstr1ToPortal({ companyId, gstin, period, ipAddress, createdBy }) {
  const run = await getRun({ companyId, gstin, period });
  if (!run) throw httpError(404, "Prepare GSTR-1 for this period first");
  if (run.error_count > 0) throw httpError(400, `Fix the ${run.error_count} blocking issue(s) and prepare again before saving`);
  if (run.stats?.isNil) throw httpError(400, "This is a nil return — there is no data to save; it's filed through the nil-return path");
  if (!SAVABLE.includes(run.stage)) throw httpError(409, `GSTR-1 for ${period} is at stage ${run.stage} and can't be saved again`);

  const bytes = Buffer.byteLength(JSON.stringify(run.payload));
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw httpError(413, `The return is ${(bytes / 1e6).toFixed(1)} MB; GSTN accepts up to 5 MB per save. Splitting large returns isn't supported yet.`);
  }

  const ctx = await portalContext({ companyId, gstin, ipAddress });

  // Claim the run atomically so a double click can't submit twice.
  const { rowCount } = await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_gstr1_runs SET stage = 'SAVE_PENDING', updated_at = now()
     WHERE company_id = $1 AND gstin = $2 AND return_period = $3 AND stage = ANY($4)`,
    [companyId, gstin, period, SAVABLE]
  );
  if (!rowCount) throw httpError(409, "A save for this period is already in progress");

  const { rows: [audit] } = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_gstr1_filings
      (company_id, gstin, financial_year, return_period, status, payload_hash, invoice_count, requested_at, created_by)
    VALUES ($1,$2,$3,$4,'DRAFT_PENDING',$5,$6,now(),$7) RETURNING id
    `,
    [companyId, gstin, run.financial_year, period, run.payload_hash, run.stats?.invoicesIncluded ?? null, createdBy || null]
  );

  try {
    const { referenceId, raw } = await whitebooks.saveGstr1Data({ ...ctx, retPeriod: run.ret_period, payload: run.payload });
    await updateRun(companyId, gstin, period, {
      validation: null,
      save_ref_id: referenceId,
      save_status: { status: "SUBMITTED", referenceId, auditId: audit.id, payloadHash: run.payload_hash, submittedAt: new Date().toISOString() },
    });
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_gstr1_filings SET response_payload = $2, updated_at = now() WHERE id = $1`,
      [audit.id, JSON.stringify({ referenceId, raw })]
    );
  } catch (err) {
    await updateRun(companyId, gstin, period, {
      stage: "SAVE_FAILED",
      save_status: { status: "SUBMIT_FAILED", message: err.message, auditId: audit.id, failedAt: new Date().toISOString() },
    });
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_gstr1_filings SET status = 'DRAFT_FAILED', error_response = $2, responded_at = now(), updated_at = now() WHERE id = $1`,
      [audit.id, JSON.stringify(err.details || { message: err.message })]
    );
    throw err;
  }
  return getRun({ companyId, gstin, period });
}

/**
 * Ask GSTN how the last save went. Leaves the run SAVE_PENDING while it's
 * still processing; moves it to SAVED or SAVE_FAILED once it's done.
 */
export async function checkGstr1SaveStatus({ companyId, gstin, period, ipAddress }) {
  const run = await getRun({ companyId, gstin, period });
  if (!run?.save_ref_id) throw httpError(404, "Nothing has been saved to the portal for this period yet");
  if (run.stage !== "SAVE_PENDING") return run;

  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { statusCode, errorReport, raw } = await whitebooks.getReturnStatus({ ...ctx, retPeriod: run.ret_period, referenceId: run.save_ref_id });
  const prev = run.save_status || {};
  const checkedAt = new Date().toISOString();

  if (statusCode === "IP" || statusCode === "REC" || !statusCode) {
    await updateRun(companyId, gstin, period, { save_status: { ...prev, status: "PROCESSING", portalStatus: statusCode, statusText: STATUS_TEXT[statusCode] || "Waiting for GSTN", checkedAt } });
    return getRun({ companyId, gstin, period });
  }

  const ok = statusCode === "P";
  const errors = ok ? [] : collectPortalErrors(errorReport);
  await updateRun(companyId, gstin, period, {
    stage: ok ? "SAVED" : "SAVE_FAILED",
    save_status: {
      ...prev,
      status: ok ? "SAVED" : "REJECTED",
      portalStatus: statusCode,
      statusText: STATUS_TEXT[statusCode] || statusCode,
      errors,
      // PE = GSTN kept the records without errors and rejected the rest.
      partial: statusCode === "PE",
      checkedAt,
      ...(ok ? { savedAt: checkedAt } : {}),
    },
  });
  if (prev.auditId) {
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_gstr1_filings
       SET status = $2, response_payload = COALESCE(response_payload, '{}'::jsonb) || $3::jsonb, error_response = $4, responded_at = now(), updated_at = now()
       WHERE id = $1`,
      [prev.auditId, ok ? "DRAFT_SAVED" : "DRAFT_FAILED", JSON.stringify({ status: raw }), ok ? null : JSON.stringify(errorReport)]
    );
  }
  return getRun({ companyId, gstin, period });
}

/**
 * Discard everything saved on the portal for the period. Only before
 * proceed-to-file. The run goes back to PREPARED.
 */
export async function resetGstr1OnPortal({ companyId, gstin, period, ipAddress }) {
  const run = await getRun({ companyId, gstin, period });
  if (!run) throw httpError(404, "No GSTR-1 run for this period");
  if (!["PREPARED", "SAVED", "SAVE_FAILED", "VALIDATED", "PROCEED_FAILED"].includes(run.stage)) {
    throw httpError(409, `GSTR-1 for ${period} is at stage ${run.stage} — portal data can't be reset now`);
  }
  const ctx = await portalContext({ companyId, gstin, ipAddress });
  const { referenceId } = await whitebooks.resetGstr1Data({ ...ctx, retPeriod: run.ret_period });
  await updateRun(companyId, gstin, period, {
    stage: "PREPARED",
    validation: null,
    save_ref_id: null,
    save_status: { status: "RESET", referenceId, resetAt: new Date().toISOString() },
  });
  return getRun({ companyId, gstin, period });
}
