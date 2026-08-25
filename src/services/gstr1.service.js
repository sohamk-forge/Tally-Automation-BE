// src/services/gstr1.service.js
//
// Phase 3: GSTR-1 draft save / summary / file / reset, wired to the
// gst_gstr1_filings audit table and the Phase 3 whitebooks.service.js
// functions (saveGstr1Draft, getGstr1Summary, resetGstr1Draft,
// fileGstr1ReturnByEvc).
//
// BLOCKED / UNCONFIRMED — see getActiveTxn() below. Every function here
// needs the txn from a completed Phase 1 login, but I don't yet know
// where that session gets persisted (gst_auth_sessions? a column on
// gst_credentials?), so this throws instead of guessing a schema.

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { decrypt } from "../utils/encryption.js";
import * as whitebooks from "./whitebooks.service.js";

async function getCredentials(companyId, gstin) {
  const { rows } = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  const creds = rows[0];
  if (!creds) {
    const err = new Error("GST credentials not found for this company/gstin — complete GST login first");
    err.code = 400;
    throw err;
  }
  if (!creds.whitebooks_email) {
    const err = new Error("No whitebooks_email stored for this company/gstin");
    err.code = 400;
    throw err;
  }
  return creds;
}

/**
 * NOT YET WIRED — placeholder.
 *
 * GSTR-1 calls need the `txn` from a *completed* Phase 1 OTP+authtoken
 * login (see whitebooks.service.js header comment: "GSTR-1 actions reuse
 * the txn_id from your completed Phase 1 login session"). I don't have
 * the schema for wherever that session/txn gets stored after Phase 1, so
 * this throws instead of inventing a table/column name.
 *
 * Send me either:
 *   - the migration for gst_auth_sessions (or wherever txn is stored), or
 *   - the function in gstAuth.service.js that already reads it back,
 * and I'll wire this for real.
 */
async function getActiveTxn(companyId, gstin) {
  const { rows } = await pool.query(
    `
    SELECT txn_id
    FROM ${DB_SCHEMA}.gst_auth_sessions
    WHERE company_id = $1
      AND gstin = $2
      AND status = 'AUTHENTICATED'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY id DESC
    LIMIT 1
    `,
    [companyId, gstin]
  );

  const session = rows[0];

  if (!session?.txn_id) {
    const err = new Error(
      "No active GST authentication session found — complete GST OTP login first"
    );
    err.code = 401;
    throw err;
  }

  return session.txn_id;
}
async function insertFilingRow({ companyId, gstin, financialYear, returnPeriod, createdBy, requestPayload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_gstr1_filings
      (company_id, gstin, financial_year, return_period, status, request_payload, requested_at, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'DRAFT_PENDING', $5, now(), $6, now(), now())
    RETURNING id
    `,
    [companyId, gstin, financialYear, returnPeriod, requestPayload ? JSON.stringify(requestPayload) : null, createdBy || null]
  );
  return rows[0].id;
}

async function updateFilingRow(id, { status, responsePayload, errorResponse, arn, invoiceCount }) {
  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.gst_gstr1_filings
    SET status = $2,
        response_payload = COALESCE($3, response_payload),
        error_response = COALESCE($4, error_response),
        arn = COALESCE($5, arn),
        invoice_count = COALESCE($6, invoice_count),
        responded_at = now(),
        updated_at = now()
    WHERE id = $1
    `,
    [id, status, responsePayload ? JSON.stringify(responsePayload) : null, errorResponse ? JSON.stringify(errorResponse) : null, arn || null, invoiceCount ?? null]
  );
}

function countInvoices(payload) {
  if (!payload) return null;
  const b2b = payload.b2b?.reduce((sum, c) => sum + (c.inv?.length || 0), 0) || 0;
  const b2cl = payload.b2cl?.reduce((sum, s) => sum + (s.inv?.length || 0), 0) || 0;
  return b2b + b2cl || null;
}

/**
 * Save a GSTR-1 draft. `gstr1Payload` is the already-normalized
 * WhiteBooks-shaped JSON (b2b/b2cl/b2cs/... sections) — building that
 * from Tally sales data is the separate normalizer step, not this file.
 */
export const saveDraft = async ({ companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, createdBy, gstr1Payload }) => {
  const creds = await getCredentials(companyId, gstin);
  const clientSecret = decrypt(creds.client_secret_enc);
  const txn = await getActiveTxn(companyId, gstin);

  const filingId = await insertFilingRow({ companyId, gstin, financialYear, returnPeriod, createdBy, requestPayload: gstr1Payload });

  try {
    const result = await whitebooks.saveGstr1Draft({
      gstin,
      retPeriod: returnPeriod,
      gstUsername,
      ipAddress,
      txn,
      clientId: creds.client_id,
      clientSecret,
      whitebooksEmail: creds.whitebooks_email,
      gstr1Payload,
    });
    await updateFilingRow(filingId, {
      status: "DRAFT_SAVED",
      responsePayload: result.raw,
      invoiceCount: countInvoices(gstr1Payload),
    });
    return { filingId, message: result.message };
  } catch (err) {
    await updateFilingRow(filingId, { status: "DRAFT_FAILED", errorResponse: err.details || { message: err.message } });
    throw err;
  }
};

/**
 * Fetch the government-computed summary + checksums for the currently
 * saved draft. Does NOT touch the filings row — this is a read, meant
 * to be called right before fileReturn().
 */
export const getSummary = async ({ companyId, gstin, returnPeriod, gstUsername, ipAddress, summaryType }) => {
  const creds = await getCredentials(companyId, gstin);
  const clientSecret = decrypt(creds.client_secret_enc);
  const txn = await getActiveTxn(companyId, gstin);

  return whitebooks.getGstr1Summary({
    gstin,
    retPeriod: returnPeriod,
    gstUsername,
    ipAddress,
    txn,
    clientId: creds.client_id,
    clientSecret,
    whitebooksEmail: creds.whitebooks_email,
    summaryType,
  });
};

/**
 * File the return via EVC/OTP. Caller must pass chksum/secSum from a
 * getSummary() call made just before this — never compute locally.
 */
export const fileReturn = async ({ companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, pan, evcOtp, chksum, secSum, createdBy }) => {
  const creds = await getCredentials(companyId, gstin);
  const clientSecret = decrypt(creds.client_secret_enc);
  const txn = await getActiveTxn(companyId, gstin);

  const filingId = await insertFilingRow({ companyId, gstin, financialYear, returnPeriod, createdBy, requestPayload: { chksum, secSum } });
  await pool.query(`UPDATE ${DB_SCHEMA}.gst_gstr1_filings SET status = 'FILE_PENDING', updated_at = now() WHERE id = $1`, [filingId]);

  try {
    const result = await whitebooks.fileGstr1ReturnByEvc({
      gstin,
      retPeriod: returnPeriod,
      gstUsername,
      ipAddress,
      txn,
      clientId: creds.client_id,
      clientSecret,
      whitebooksEmail: creds.whitebooks_email,
      pan,
      evcOtp,
      chksum,
      secSum,
    });
    await updateFilingRow(filingId, { status: "FILED", responsePayload: result.raw, arn: result.arn });
    return { filingId, arn: result.arn };
  } catch (err) {
    await updateFilingRow(filingId, { status: "FILE_FAILED", errorResponse: err.details || { message: err.message } });
    throw err;
  }
};

/**
 * Undo a saved-but-unfiled draft.
 */
export const resetDraft = async ({ companyId, gstin, returnPeriod, gstUsername, ipAddress }) => {
  const creds = await getCredentials(companyId, gstin);
  const clientSecret = decrypt(creds.client_secret_enc);
  const txn = await getActiveTxn(companyId, gstin);

  return whitebooks.resetGstr1Draft({
    gstin,
    retPeriod: returnPeriod,
    gstUsername,
    ipAddress,
    txn,
    clientId: creds.client_id,
    clientSecret,
    whitebooksEmail: creds.whitebooks_email,
  });
};

/**
 * History of save/file attempts for a company+gstin+period, from the
 * gst_gstr1_filings audit table — no WhiteBooks call.
 */
export const getFilingHistory = async ({ companyId, gstin, financialYear, returnPeriod }) => {
  const { rows } = await pool.query(
    `
    SELECT id, status, arn, invoice_count, requested_at, responded_at, created_at
    FROM ${DB_SCHEMA}.gst_gstr1_filings
    WHERE company_id = $1 AND gstin = $2 AND financial_year = $3 AND return_period = $4
    ORDER BY id DESC
    `,
    [companyId, gstin, financialYear, returnPeriod]
  );
  return rows;
};