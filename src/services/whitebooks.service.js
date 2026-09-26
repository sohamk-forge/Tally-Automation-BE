// src/services/whitebooks.service.js
//
// Matches the WhiteBooks sandbox contract from their docs
// (apisandbox.whitebooks.in).
//
// AUTHENTICATION (Phase 1 — requires OTP session):
//   GET /authentication/otprequest
//   GET /authentication/authtoken
//
// PUBLIC (Phase 2 — no OTP session required, just client_id/secret):
//   GET /public/pref       — per-quarter filing PREFERENCE (Monthly/Quarterly,
//                             QRMP scheme). Only supported FY 2020-21 onward.
//     query:  gstin, fy, email
//     headers: state_cd, ip_address, client_id, client_secret
//   GET /public/rettrack   — list of ALREADY-FILED returns for this
//                             gstin/fy/type. Confirmed real shape:
//                               { data: { EFiledlist: [
//                                   { valid, mof, dof, ret_prd, rtntype, arn, status }
//                               ] } }
//                             ret_prd is "MMYYYY" (e.g. "082017" = Aug 2017).
//                             arn is the acknowledgement reference number —
//                             the same kind of value GSTR-1 filing will
//                             need to store later.
//     query:  gstin, fy, type, email
//     headers: client_id, client_secret   (no state_cd/ip_address)
//
// `email` is the WhiteBooks developer/account email tied to a given
// client_id + client_secret pair — passed in per-call, sourced from that
// company's row in gst_credentials, never a global .env value.
//
// IMPORTANT: WhiteBooks returns HTTP 200 even on business-logic failures —
// the failure is signalled inside the JSON body via status_cd/status_desc/
// error, not the HTTP status code. Their success flag has been observed as
// the literal typo "Sucess" — we only detect the FAILURE shape, never gate
// success on a specific value.

import crypto from "crypto";

const MOCK_MODE = String(process.env.GST_MOCK_MODE || "true").toLowerCase() === "true";
const BASE_URL = process.env.WHITEBOOKS_BASE_URL; // https://apisandbox.whitebooks.in in sandbox

export function stateCodeFromGstin(gstin) {
  return gstin?.slice(0, 2);
}

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

  if (!resp.ok) {
    const err = new Error(data.message || data.error?.errorMessage || "WhiteBooks request failed");
    err.details = data;
    throw err;
  }

  const wbError = extractWhiteBooksError(data);
  if (wbError) {
    const err = new Error(`WhiteBooks: ${wbError.message}${wbError.errorCode ? ` (${wbError.errorCode})` : ""}`);
    err.details = data;
    err.whiteBooksErrorCode = wbError.errorCode;
    throw err;
  }

  return data;
}

/* ============================================================
   PHASE 1 — AUTHENTICATION (OTP-based session)
============================================================ */

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

export async function verifyOtpAndGetToken({
  gstin, otp, txn, clientId, clientSecret, gstUsername, ipAddress, whitebooksEmail,
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

/* ============================================================
   PHASE 2 — PUBLIC APIS (no OTP session required)
============================================================ */

const FREQUENCY_CODE_MAP = { M: "MONTHLY", Q: "QUARTERLY" };

/**
 * GET /public/pref — per-quarter filing preference (Monthly/Quarterly).
 * Only supported for FY 2020-21 onward — caller should skip calling this
 * for earlier years rather than rely on the error (see gstReturnStatus.service.js).
 */
export async function getFilingPreference({ gstin, financialYear, clientId, clientSecret, ipAddress, whitebooksEmail }) {
  if (MOCK_MODE) {
    return {
      preferences: [
        { quarter: "Q1", frequency: "MONTHLY" },
        { quarter: "Q2", frequency: "MONTHLY" },
        { quarter: "Q3", frequency: "MONTHLY" },
        { quarter: "Q4", frequency: "MONTHLY" },
      ],
      raw: { status_cd: "1", status_desc: "mock" },
    };
  }
  if (!whitebooksEmail) {
    throw new Error("whitebooksEmail is required for /public/pref");
  }

  const data = await callWhiteBooks("/public/pref", {
    query: { gstin, fy: financialYear, email: whitebooksEmail },
    headers: {
      state_cd: stateCodeFromGstin(gstin),
      ip_address: ipAddress || "0.0.0.0",
      client_id: clientId,
      client_secret: clientSecret,
    },
  });

  const rows = data.data?.response || [];
  const preferences = rows.map((r) => ({
    quarter: r.quarter,
    frequency: FREQUENCY_CODE_MAP[r.preference] || r.preference || null,
  }));

  return { preferences, raw: data };
}

/**
 * MMYYYY -> "MM-YYYY", e.g. "082017" -> "08-2017". Returns the raw value
 * unchanged if it doesn't match the expected 6-digit shape.
 */
function formatReturnPeriod(retPrd) {
  if (typeof retPrd === "string" && /^\d{6}$/.test(retPrd)) {
    return `${retPrd.slice(0, 2)}-${retPrd.slice(2)}`;
  }
  return retPrd || null;
}

/**
 * GET /public/rettrack — list of already-filed returns for this
 * gstin/fy/type. Confirmed real shape via WhiteBooks' own Playground:
 *   { data: { EFiledlist: [{ valid, mof, dof, ret_prd, rtntype, arn, status }] } }
 */
export async function trackReturnStatus({ gstin, financialYear, returnType, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    return {
      filings: [
        {
          returnPeriod: "08-2026",
          returnType: "GSTR1",
          filingDate: "01-09-2026",
          arn: "MOCKARN-00000001",
          status: "Filed",
          valid: true,
        },
      ],
      raw: { status_cd: "1", status_desc: "mock" },
    };
  }
  if (!whitebooksEmail) {
    throw new Error("whitebooksEmail is required for /public/rettrack");
  }

  const data = await callWhiteBooks("/public/rettrack", {
    query: { gstin, fy: financialYear, type: returnType, email: whitebooksEmail },
    headers: {
      client_id: clientId,
      client_secret: clientSecret,
    },
  });

  const rows = data.data?.EFiledlist || [];
  const filings = rows.map((r) => ({
    returnPeriod: formatReturnPeriod(r.ret_prd),
    returnType: r.rtntype,
    filingDate: r.dof,
    arn: r.arn,
    status: r.status,
    valid: r.valid === "Y",
  }));

  return { filings, raw: data };
}

export const isMockMode = MOCK_MODE;