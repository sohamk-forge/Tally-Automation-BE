// src/services/gstAuth.service.js
//
// Mirrors the shape of services/account.service.js: named async exports,
// raw pool.query with $-params, everything schema-qualified via DB_SCHEMA.
// Route handlers call these directly (no separate controller layer, same
// as account.routes.js).

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { encrypt } from "../utils/encryption.js";
import * as whitebooks from "./whitebooks.service.js";
import { isValidGstin } from "./gstr1/gstMasters.js";


/**
 * Step 0: what the GST Login screen needs before "Send OTP".
 * GSTIN comes from company_details (synced from Tally); if that's empty we
 * fall back to the GSTIN the user typed on an earlier login. The GST
 * username is whatever was saved on the first login, if any.
 */
export const getGstLoginSetup = async ({ companyId }) => {
  const { rows: detailRows } = await pool.query(
    `SELECT gstin FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
    [companyId]
  );
  const companyGstin = detailRows[0]?.gstin?.trim().toUpperCase() || null;

  const { rows: credRows } = await pool.query(
    `
    SELECT gstin, gst_username FROM ${DB_SCHEMA}.gst_credentials
    WHERE company_id = $1
    ORDER BY (gstin = $2) DESC, updated_at DESC
    LIMIT 1
    `,
    [companyId, companyGstin]
  );
  const saved = credRows[0];

  const gstin = companyGstin || saved?.gstin || null;
  return {
    gstin,
    gstinSource: companyGstin ? "company_details" : saved?.gstin ? "gst_credentials" : null,
    stateCode: gstin ? whitebooks.stateCodeFromGstin(gstin) : null,
    gstUsername: saved && saved.gstin === gstin ? saved.gst_username : null,
  };
};

/**
 * Step 1: remember the GSTIN + GST username for this company, then ask
 * WhiteBooks to send the OTP. client_id/secret/email/base URL come from
 * .env (getWhiteBooksConfig); state_cd is the first two digits of the GSTIN.
 * The returned txn is stored in gst_auth_sessions for verify-otp and for
 * every authenticated call after that.
 */
export const startGstOtpRequest = async ({ companyId, gstin, gstUsername, createdBy, ipAddress }) => {
  gstin = String(gstin || "").trim().toUpperCase();
  gstUsername = String(gstUsername || "").trim();
  // Format + check digit: a mistyped GSTIN would otherwise be saved as the
  // company's and every later call would go to the wrong registration.
  if (!isValidGstin(gstin)) {
    const err = new Error("That isn't a valid GSTIN — check the 15 characters (the last one is a check digit)");
    err.code = 400;
    throw err;
  }
  if (!gstUsername) {
    const err = new Error("GST username is required");
    err.code = 400;
    throw err;
  }

  const config = whitebooks.getWhiteBooksConfig();

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_credentials (company_id, gstin, gst_username, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (company_id, gstin) DO UPDATE SET
      gst_username = EXCLUDED.gst_username,
      updated_at = now()
    `,
    [companyId, gstin, gstUsername]
  );

  const { txn, message } = await whitebooks.requestOtp({
    gstin,
    gstUsername,
    ipAddress: config.ipAddress || ipAddress,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    whitebooksEmail: config.whitebooksEmail,
  });

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_auth_sessions
      (company_id, gstin, txn_id, status, created_by, updated_at)
    VALUES ($1, $2, $3, 'PENDING_OTP', $4, now())
    `,
    [companyId, gstin, txn, createdBy || null]
  );

  return { txn, message, gstin };
};

/**
 * Step 2: GET /authentication/authtoken with the OTP + the txn from step 1
 * (headers gst_username, state_cd, ip_address, txn, client_id, client_secret).
 * gst_username comes from gst_credentials; everything else from .env/gstin.
 *
 * A wrong OTP leaves the session PENDING_OTP so the user can re-type it;
 * WhiteBooks' own message is passed back with a 400.
 */
export const verifyGstOtp = async ({ companyId, gstin, txn, otp, ipAddress }) => {
  const { rows } = await pool.query(
    `
    SELECT * FROM ${DB_SCHEMA}.gst_auth_sessions
    WHERE company_id = $1 AND gstin = $2 AND txn_id = $3
    ORDER BY id DESC LIMIT 1
    `,
    [companyId, gstin, txn]
  );
  const session = rows[0];
  if (!session) {
    return { error: "No matching OTP session found for this TXN — request a new OTP", code: 404 };
  }
  if (session.status === "AUTHENTICATED" && (!session.expires_at || new Date(session.expires_at) > new Date())) {
    return { status: "AUTHENTICATED", expiresAt: session.expires_at, alreadyDone: true };
  }
  if (session.status !== "PENDING_OTP") {
    return { error: "This OTP request is no longer valid — request a new OTP", code: 410 };
  }

  const { rows: credRows } = await pool.query(
    `SELECT gst_username FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  const creds = credRows[0];
  if (!creds?.gst_username) {
    return { error: "GST username not found — request the OTP again", code: 400 };
  }
  const config = whitebooks.getWhiteBooksConfig();

  let tokenResult;
  try {
    tokenResult = await whitebooks.verifyOtpAndGetToken({
      gstin,
      otp,
      txn,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      gstUsername: creds.gst_username,
      whitebooksEmail: config.whitebooksEmail,
      ipAddress: config.ipAddress || ipAddress,
    });
  } catch (err) {
    // WhiteBooks rejected it (status_cd "0"): almost always a wrong/expired OTP.
    if (err.details?.status_cd === "0" || err.details?.error) {
      return { error: err.message.replace(/^WhiteBooks: /, "") || "Invalid OTP", code: 400 };
    }
    throw err;
  }

  const { authToken, refId, expiresAt } = tokenResult;

  // Only one live session per company+GSTIN — retire older ones.
  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.gst_auth_sessions
    SET status = 'EXPIRED', updated_at = now()
    WHERE company_id = $1 AND gstin = $2 AND status = 'AUTHENTICATED' AND id <> $3
    `,
    [companyId, gstin, session.id]
  );
  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.gst_auth_sessions
    SET ref_id = $1, auth_token_enc = $2, expires_at = $3, status = 'AUTHENTICATED', updated_at = now()
    WHERE id = $4
    `,
    [refId, authToken ? encrypt(authToken) : null, expiresAt, session.id]
  );

  return { status: "AUTHENTICATED", expiresAt };
};

/**
 * Step 2b: refresh the live session before its 6h expiry (the frontend
 * calls this ~20 min before). Works only while the session is still valid —
 * once it has expired, or WhiteBooks rejects the refresh, a fresh OTP login
 * is the only way back in, so the session is marked EXPIRED.
 */
export const refreshGstSession = async ({ companyId, gstin, ipAddress }) => {
  const { rows } = await pool.query(
    `
    SELECT * FROM ${DB_SCHEMA}.gst_auth_sessions
    WHERE company_id = $1 AND gstin = $2 AND status = 'AUTHENTICATED'
    ORDER BY id DESC LIMIT 1
    `,
    [companyId, gstin]
  );
  const session = rows[0];
  if (!session || (session.expires_at && new Date(session.expires_at) <= new Date())) {
    if (session) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.gst_auth_sessions SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
        [session.id]
      );
    }
    return { error: "GST session has expired — log in with OTP again", code: 401 };
  }

  const { rows: credRows } = await pool.query(
    `SELECT gst_username FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  const config = whitebooks.getWhiteBooksConfig();

  let result;
  try {
    result = await whitebooks.refreshAuthToken({
      gstin,
      txn: session.txn_id,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      gstUsername: credRows[0]?.gst_username,
      whitebooksEmail: config.whitebooksEmail,
      ipAddress: config.ipAddress || ipAddress,
    });
  } catch (err) {
    if (err.details?.status_cd === "0" || err.details?.error) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.gst_auth_sessions SET status = 'EXPIRED', updated_at = now() WHERE id = $1`,
        [session.id]
      );
      return { error: `GST session could not be refreshed — log in with OTP again (${err.message.replace(/^WhiteBooks: /, "")})`, code: 401 };
    }
    throw err; // network/config problem — session left as is so a retry can still work
  }

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.gst_auth_sessions
    SET txn_id = $1,
        auth_token_enc = COALESCE($2, auth_token_enc),
        expires_at = $3,
        updated_at = now()
    WHERE id = $4
    `,
    [result.txn, result.authToken ? encrypt(result.authToken) : null, result.expiresAt, session.id]
  );

  return { status: "AUTHENTICATED", expiresAt: result.expiresAt, txnChanged: result.txn !== session.txn_id };
};

/**
 * The live session for authenticated WhiteBooks calls: its txn (WhiteBooks
 * keys the GSTN token on it) and the GST username it was opened with.
 * Throws a 401-coded error when the user needs to log in with OTP again.
 */
export const getActiveGstSession = async ({ companyId, gstin }) => {
  const { rows } = await pool.query(
    `
    SELECT s.txn_id, s.expires_at, c.gst_username
    FROM ${DB_SCHEMA}.gst_auth_sessions s
    JOIN ${DB_SCHEMA}.gst_credentials c ON c.company_id = s.company_id AND c.gstin = s.gstin
    WHERE s.company_id = $1 AND s.gstin = $2 AND s.status = 'AUTHENTICATED'
      AND (s.expires_at IS NULL OR s.expires_at > now())
    ORDER BY s.id DESC LIMIT 1
    `,
    [companyId, gstin]
  );
  if (!rows[0]?.txn_id) {
    const err = new Error("GST session has expired — log in with OTP again");
    err.code = 401;
    throw err;
  }
  return { txn: rows[0].txn_id, gstUsername: rows[0].gst_username, expiresAt: rows[0].expires_at };
};

/**
 * Step 3: connection status for the frontend — never exposes the token.
 */
export const getGstConnectionStatus = async ({ companyId, gstin }) => {
  const { rows } = await pool.query(
    `
    SELECT status, gstin, expires_at FROM ${DB_SCHEMA}.gst_auth_sessions
    WHERE company_id = $1 AND gstin = $2
    ORDER BY id DESC LIMIT 1
    `,
    [companyId, gstin]
  );
  const session = rows[0];
  if (!session) {
    return { connected: false, gstin, status: "NOT_CONNECTED" };
  }
  const expired = session.expires_at && new Date(session.expires_at) < new Date();
  const status = expired ? "EXPIRED" : session.status;
  return { connected: status === "AUTHENTICATED", gstin: session.gstin, status, expiresAt: session.expires_at };
};