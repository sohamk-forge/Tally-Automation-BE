// src/services/gstAuth.service.js
//
// Mirrors the shape of services/account.service.js: named async exports,
// raw pool.query with $-params, everything schema-qualified via DB_SCHEMA.
// Route handlers call these directly (no separate controller layer, same
// as account.routes.js).

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import * as whitebooks from "./whitebooks.service.js";

/**
 * Step 1: save/update the credentials the user typed on the GST Login
 * screen (including their own WhiteBooks account email — different
 * companies can use different WhiteBooks accounts), then ask WhiteBooks
 * to trigger an OTP. Returns the TXN.
 */
export const startGstOtpRequest = async ({
  companyId,
  gstin,
  clientId,
  clientSecret,
  gstUsername,
  gstPassword,
  whitebooksEmail,
  createdBy,
  ipAddress,
}) => {
  if (!gstUsername) {
    throw new Error("gstUsername is required — WhiteBooks otprequest has no gstin field, it resolves via gst_username");
  }
  if (!whitebooksEmail) {
    throw new Error("whitebooksEmail is required — this is the WhiteBooks account email tied to clientId/clientSecret");
  }

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_credentials
      (company_id, gstin, client_id, client_secret_enc, gst_username, gst_password_enc, whitebooks_email, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (company_id, gstin) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      client_secret_enc = EXCLUDED.client_secret_enc,
      gst_username = EXCLUDED.gst_username,
      gst_password_enc = EXCLUDED.gst_password_enc,
      whitebooks_email = EXCLUDED.whitebooks_email,
      updated_at = now()
    `,
    [
      companyId,
      gstin,
      clientId,
      encrypt(clientSecret),
      gstUsername,
      gstPassword ? encrypt(gstPassword) : null,
      whitebooksEmail,
    ]
  );

  const { txn, message } = await whitebooks.requestOtp({
    gstin,
    clientId,
    clientSecret,
    gstUsername,
    ipAddress,
    whitebooksEmail,
  });

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_auth_sessions
      (company_id, gstin, txn_id, status, created_by, updated_at)
    VALUES ($1, $2, $3, 'PENDING_OTP', $4, now())
    `,
    [companyId, gstin, txn, createdBy || null]
  );

  return { txn, message };
};

/**
 * Step 2: verify the OTP against the TXN via WhiteBooks, then store
 * whatever TXN/REF ID/auth token WhiteBooks actually returned.
 * whitebooksEmail/gstUsername are pulled back out of gst_credentials —
 * the caller never needs to resend them.
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
    return { error: "No matching OTP session found for this TXN", code: 404 };
  }
  if (session.status === "AUTHENTICATED") {
    return { status: "AUTHENTICATED", alreadyDone: true };
  }

  const { rows: credRows } = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  const creds = credRows[0];
  if (!creds) {
    return { error: "GST credentials not found — call request-otp first", code: 400 };
  }
  if (!creds.whitebooks_email) {
    return {
      error: "No whitebooks_email stored for this company/gstin — call request-otp again to set it",
      code: 400,
    };
  }

  let tokenResult;
  try {
    tokenResult = await whitebooks.verifyOtpAndGetToken({
      gstin,
      otp,
      txn,
      clientId: creds.client_id,
      clientSecret: decrypt(creds.client_secret_enc),
      gstUsername: creds.gst_username,
      whitebooksEmail: creds.whitebooks_email,
      ipAddress,
    });
  } catch (err) {
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_auth_sessions SET status = 'FAILED', updated_at = now() WHERE id = $1`,
      [session.id]
    );
    throw err;
  }

  const { authToken, refId, expiresAt } = tokenResult;
  if (!authToken) {
    await pool.query(
      `UPDATE ${DB_SCHEMA}.gst_auth_sessions SET status = 'FAILED', updated_at = now() WHERE id = $1`,
      [session.id]
    );
    return { error: "OTP verification failed", code: 401 };
  }

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.gst_auth_sessions
    SET ref_id = $1, auth_token_enc = $2, expires_at = $3, status = 'AUTHENTICATED', updated_at = now()
    WHERE id = $4
    `,
    [refId || null, encrypt(authToken), expiresAt || null, session.id]
  );

  return { status: "AUTHENTICATED" };
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
  return { connected: status === "AUTHENTICATED", gstin: session.gstin, status };
};