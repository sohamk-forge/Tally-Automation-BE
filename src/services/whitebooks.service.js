// src/services/whitebooks.service.js
//
// Matches the WhiteBooks sandbox contract from their Swagger docs
// (apisandbox.whitebooks.in):
//
//   GET /authentication/otprequest
//     query:  email
//     headers: gst_username, state_cd, ip_address, client_id, client_secret
//
//   GET /authentication/authtoken
//     query:  email, otp
//     headers: gst_username, state_cd, ip_address, txn, client_id, client_secret
//
// `email` is the WhiteBooks developer/account email tied to a given
// client_id + client_secret pair. Different companies can have entirely
// different WhiteBooks accounts, so this is NOT a global .env value — it's
// passed in per-call, sourced from that company's row in gst_credentials.
//
// IMPORTANT: WhiteBooks returns HTTP 200 even on business-logic failures
// (bad gst_username, expired access, etc) — the failure is signalled inside
// the JSON body via status_cd/status_desc/error, not the HTTP status code.
// We detect that envelope explicitly so failures surface as a clean message
// instead of a confusing "field not found" error.

import crypto from "crypto";

const MOCK_MODE = String(process.env.GST_MOCK_MODE || "true").toLowerCase() === "true";
const BASE_URL = process.env.WHITEBOOKS_BASE_URL; // https://apisandbox.whitebooks.in in sandbox

/**
 * GSTIN's first two characters are always the GST state code
 * (e.g. "27AAAPL1234C1ZV" -> "27"). WhiteBooks wants this separately.
 */
export function stateCodeFromGstin(gstin) {
  return gstin?.slice(0, 2);
}

/**
 * WhiteBooks' documented failure shape looks like:
 *   { status_cd: "0", status_desc: "user name does not exists",
 *     error: { errorCode: "AUTH4037", errorMessage: "..." } }
 * status_cd "1" (or absent, with real data present) means success.
 */
function extractWhiteBooksError(data) {
  if (data?.status_cd === "0" || data?.error) {
    const parts = [data.status_desc, data.error?.errorMessage].filter(Boolean);
    return {
      message: parts.join(" — ") || "WhiteBooks rejected the request",
      errorCode: data.error?.errorCode || null,
    };
  }
  return null;
}

async function callWhiteBooks(path, { query, headers }) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...headers,
    },
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`WhiteBooks returned non-JSON response (status ${resp.status})`);
    err.details = { raw: text, status: resp.status };
    throw err;
  }

  // HTTP-level failure (rare for WhiteBooks, but handle it anyway)
  if (!resp.ok) {
    const err = new Error(data.message || data.error?.errorMessage || "WhiteBooks request failed");
    err.details = data;
    throw err;
  }

  // Business-logic failure inside a 200 response — this is the common case
  const wbError = extractWhiteBooksError(data);
  if (wbError) {
    const err = new Error(`WhiteBooks: ${wbError.message}${wbError.errorCode ? ` (${wbError.errorCode})` : ""}`);
    err.details = data;
    err.whiteBooksErrorCode = wbError.errorCode;
    throw err;
  }

  return data;
}

/**
 * Step A: trigger an OTP for this GSTIN (via its gst_username).
 */
export async function requestOtp({ gstin, clientId, clientSecret, gstUsername, ipAddress, whitebooksEmail }) {
  if (MOCK_MODE) {
    const txn = "MOCKTXN-" + crypto.randomBytes(6).toString("hex").toUpperCase();
    return { txn, message: "OTP sent successfully (mock)" };
  }

  if (!whitebooksEmail) {
    throw new Error("whitebooksEmail is required — pass the WhiteBooks account email tied to this company's client_id");
  }

  const data = await callWhiteBooks("/authentication/otprequest", {
    query: { email: whitebooksEmail },
    headers: {
      gst_username: gstUsername,
      state_cd: stateCodeFromGstin(gstin),
      ip_address: ipAddress || "0.0.0.0",
      client_id: clientId,
      client_secret: clientSecret,
    },
  });

  const txn = data.txn || data.data?.txn || data.result?.txn;
  if (!txn) {
    const err = new Error("WhiteBooks otprequest succeeded but no txn found in response — check shape");
    err.details = data;
    throw err;
  }

  return { txn, message: data.message || data.status_desc || "OTP sent successfully" };
}

/**
 * Step B: exchange gst_username + OTP + TXN for an auth token.
 */
export async function verifyOtpAndGetToken({
  gstin,
  otp,
  txn,
  clientId,
  clientSecret,
  gstUsername,
  ipAddress,
  whitebooksEmail,
}) {
  if (MOCK_MODE) {
    return {
      authToken: "MOCKAUTH-" + crypto.randomBytes(16).toString("hex"),
      refId: "MOCKREF-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    };
  }

  if (!whitebooksEmail) {
    throw new Error("whitebooksEmail is required — pass the WhiteBooks account email tied to this company's client_id");
  }

  const data = await callWhiteBooks("/authentication/authtoken", {
    query: { email: whitebooksEmail, otp },
    headers: {
      gst_username: gstUsername,
      state_cd: stateCodeFromGstin(gstin),
      ip_address: ipAddress || "0.0.0.0",
      txn,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });

  const authToken = data.authtoken || data.auth_token || data.data?.authtoken;
  const refId = data.refid || data.ref_id || data.data?.refid;
  const expiresAt = data.expiry || data.expires_at || data.data?.expiry || null;

  if (!authToken) {
    const err = new Error("WhiteBooks authtoken succeeded but no authtoken found in response — check shape");
    err.details = data;
    throw err;
  }

  return { authToken, refId, expiresAt };
}

export const isMockMode = MOCK_MODE;