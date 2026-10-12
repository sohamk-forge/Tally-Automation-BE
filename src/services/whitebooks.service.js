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
import { readFileSync } from "fs";

const MOCK_MODE = String(process.env.GST_MOCK_MODE || "true").toLowerCase() === "true";
const BASE_URL = process.env.WHITEBOOKS_BASE_URL; // https://apisandbox.whitebooks.in in sandbox

export function stateCodeFromGstin(gstin) {
  return gstin?.slice(0, 2);
}

/**
 * Platform WhiteBooks account — client_id, client_secret, account email and
 * (optionally) a fixed ip_address all come from .env, never from the user.
 */
export function getWhiteBooksConfig() {
  const config = {
    clientId: process.env.WHITEBOOKS_CLIENT_ID,
    clientSecret: process.env.WHITEBOOKS_CLIENT_SECRET,
    whitebooksEmail: process.env.WHITEBOOKS_EMAIL,
    ipAddress: process.env.WHITEBOOKS_IP_ADDRESS || null,
  };
  if (!MOCK_MODE) {
    const missing = [
      ["WHITEBOOKS_BASE_URL", BASE_URL],
      ["WHITEBOOKS_CLIENT_ID", config.clientId],
      ["WHITEBOOKS_CLIENT_SECRET", config.clientSecret],
      ["WHITEBOOKS_EMAIL", config.whitebooksEmail],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      const err = new Error(`WhiteBooks is not configured on the server — missing ${missing.join(", ")}`);
      err.code = 500;
      throw err;
    }
  }
  return config;
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

async function callWhiteBooks(path, { query, headers, method = "GET", body }) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const resp = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    // Like the real sandbox reply ({ status_cd: "1", status_desc }): WhiteBooks
    // keeps the GSTN token on its side, keyed by txn — none comes back.
    return { authToken: null, refId: null, expiresAt: resolveExpiry(null), raw: { status_cd: "1", status_desc: "If authentication succeeds" } };
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

  // callWhiteBooks already threw on status_cd "0" (wrong/expired OTP), so
  // reaching here means GSTN accepted the OTP. WhiteBooks may keep the GSTN
  // auth token on its side (keyed by txn) and return only status_cd/desc —
  // so a token in the body is stored if present but never required.
  const authToken = data.authtoken || data.auth_token || data.data?.authtoken || data.data?.auth_token || null;
  const refId = data.refid || data.ref_id || data.data?.refid || data.data?.ref_id || null;
  return {
    authToken,
    refId,
    expiresAt: resolveExpiry(data.expiry ?? data.expires_at ?? data.data?.expiry),
    raw: data,
  };
}

/**
 * GSTN auth tokens live 6 hours. "expiry" may come back as minutes (GSTN
 * returns 360), seconds, or a timestamp; fall back to 6h from now.
 */
const SESSION_MS = 6 * 60 * 60 * 1000;
export function resolveExpiry(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    if (n <= 24 * 60) return new Date(Date.now() + n * 60 * 1000).toISOString(); // minutes
    if (n <= 24 * 60 * 60) return new Date(Date.now() + n * 1000).toISOString(); // seconds
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) return d.toISOString();
  }
  return new Date(Date.now() + SESSION_MS).toISOString();
}

/**
 * GET /authentication/refreshtoken — extends the GSTN session tied to `txn`
 * by another 6h without a new OTP. Same headers as authtoken, minus the OTP.
 * If WhiteBooks hands back a new txn, the caller must switch to it.
 */
export async function refreshAuthToken({ gstin, txn, clientId, clientSecret, gstUsername, ipAddress, whitebooksEmail }) {
  if (MOCK_MODE) {
    return { txn, authToken: null, expiresAt: resolveExpiry(null), raw: { status_cd: "1", status_desc: "mock refresh" } };
  }

  const data = await callWhiteBooks("/authentication/refreshtoken", {
    query: { email: whitebooksEmail },
    headers: {
      gst_username: gstUsername,
      state_cd: stateCodeFromGstin(gstin),
      ip_address: ipAddress || "0.0.0.0",
      txn,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });

  return {
    txn: data.txn || data.data?.txn || txn,
    authToken: data.authtoken || data.auth_token || data.data?.authtoken || data.data?.auth_token || null,
    expiresAt: resolveExpiry(data.expiry ?? data.expires_at ?? data.data?.expiry),
    raw: data,
  };
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
    // Only the asked-for financial year, like the real rettrack. Earlier
    // years are fully filed; returns filed through the mock are added.
    const fyStart = parseInt(String(financialYear).slice(0, 4), 10);
    const inFy = (p) => { const [m, y] = p.split("-").map(Number); return (m >= 4 ? y : y - 1) === fyStart; };
    const filed = (p, type) => ({ returnPeriod: p, returnType: type, filingDate: null, arn: `MOCKARN-${type}-${p}`, status: "Filed", valid: true });
    let base = mockControl.filings;
    if (!base) {
      base = fyStart < 2026
        ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].flatMap((m) => { const p = `${String(m).padStart(2, "0")}-${m >= 4 ? fyStart : fyStart + 1}`; return [filed(p, "GSTR1"), filed(p, "GSTR3B")]; })
        : [filed("04-2026", "GSTR1"), filed("04-2026", "GSTR3B"), filed("05-2026", "GSTR1"), filed("05-2026", "GSTR3B"), filed("06-2026", "GSTR1")];
    }
    return { filings: [...base, ...mockFiledReturns].filter((f) => inFy(f.returnPeriod)), raw: { status_cd: "1", status_desc: "mock" } };
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

/**
 * GET /public/search — the taxpayer's registration record. Used for the
 * registration date (no periods before it), taxpayer type (Regular /
 * Composition) and status (Active / Cancelled). Headers per the Postman
 * collection: client_id + client_secret only.
 */
export async function searchTaxpayer({ gstin, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    return {
      registrationDate: "01/07/2017",
      taxpayerType: "Regular",
      status: "Active",
      legalName: "MOCK TAXPAYER",
      tradeName: "MOCK TRADERS",
      raw: { status_cd: "1", status_desc: "mock" },
    };
  }

  const data = await callWhiteBooks("/public/search", {
    query: { email: whitebooksEmail, gstin },
    headers: { client_id: clientId, client_secret: clientSecret },
  });
  const d = data.data || {};
  return {
    registrationDate: d.rgdt || null, // "DD/MM/YYYY"
    taxpayerType: d.dty || null, // "Regular" | "Composition" | ...
    status: d.sts || null, // "Active" | "Cancelled" | ...
    legalName: d.lgnm || null,
    tradeName: d.tradeNam || null,
    raw: data,
  };
}

/* ============================================================
   AUTHENTICATED CALLS — need the txn of a live OTP session
============================================================ */

/** Headers every authenticated WhiteBooks call carries. */
function authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }) {
  return {
    gst_username: gstUsername,
    state_cd: stateCodeFromGstin(gstin),
    ip_address: ipAddress || "0.0.0.0",
    txn,
    client_id: clientId,
    client_secret: clientSecret,
  };
}

let imsSample = null;
const loadImsSample = () => {
  imsSample ||= JSON.parse(readFileSync(new URL("./ims/imsSample.json", import.meta.url), "utf8"));
  return imsSample;
};

/**
 * GET /ims/invoices — invoices suppliers have filed that are waiting in IMS,
 * for one section (B2B, B2BA, B2BCN, B2BDN, ...). Not period-scoped: each
 * row carries the supplier's return period (rtnprd). `status` filters by
 * action; empty = all.
 * Returns the section's rows: [{ stin, inum, idt, val, txval, iamt, camt, samt, cess, rtnprd, action, ispendactblocked, hash, ... }]
 */
export async function getImsInvoices({ gstin, section, status = "", txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    // The sample from the WhiteBooks collection (B2B only).
    if (section !== "B2B") return [];
    return loadImsSample().data.b2b.map((r) => ({ ...r, action: mockImsActions.get(imsKeyOf(gstin, r)) || r.action }));
  }
  const data = await callWhiteBooks("/ims/invoices", {
    query: { gstin, section, email: whitebooksEmail, status },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  const d = data.data || {};
  return d[section.toLowerCase()] || d[section] || [];
}

/** Headers for calls that write a return: auth headers + gstin / ret_period. */
const returnHeaders = (a) => ({ gstin: a.gstin, ret_period: a.retPeriod, ...authHeaders(a) });

/** GSTN reference id from a save / reset / proceed response, wherever WhiteBooks puts it. */
function referenceIdOf(data) {
  const d = data?.data ?? data;
  return d?.reference_id || d?.ref_id || d?.referenceId || d?.int_tran_id || data?.reference_id || null;
}

// Mock: each reference reports "in progress" once, then "processed".
const mockRefs = new Map();
const mockFiledReturns = []; // returns filed through the mock, reported back by mock rettrack
const mock3b = new Map(); // `${gstin}|${retPeriod}` -> { payload, offset, filed }
const mockImsActions = new Map(); // `${gstin}|${stin}|${inum}|${idt}` -> action saved on the mock portal

/**
 * PUT /gstr1/retsave — upload the GSTR-1 data. Processing is asynchronous:
 * the response only carries a reference id; poll getReturnStatus() with it.
 */
export async function saveGstr1Data({ gstin, retPeriod, payload, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const ref = "MOCKREF-R1-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 0);
    mockRefs.set(`${ref}:outcome`, mockControl.saveOutcome);
    // A record GSTN rejects isn't kept; with "PE" the rest is.
    if (mockControl.saveOutcome !== "ER") mockSaved.set(`${gstin}|${retPeriod}`, payload);
    return { referenceId: ref, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/gstr1/retsave", {
    method: "PUT",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body: payload,
  });
  const referenceId = referenceIdOf(data);
  if (!referenceId) {
    const err = new Error("GST portal accepted the save but returned no reference id — check the response shape");
    err.details = data;
    throw err;
  }
  return { referenceId, raw: data };
}

/**
 * GET /gstr/retstatus — processing status of a save / reset by reference id.
 * GSTN status codes: P processed, PE processed with errors, ER error,
 * IP in progress, REC received. error_report lists failed records.
 */
export async function getReturnStatus({ gstin, retPeriod, referenceId, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const seen = mockRefs.get(referenceId) ?? 1;
    mockRefs.set(referenceId, seen + 1);
    const code = seen === 0 ? "IP" : mockRefs.get(`${referenceId}:outcome`) || "P";
    const errorReport = code === "P" || code === "IP" ? null : mockControl.saveErrorReport || { error_msg: "Rejected (mock)" };
    return { statusCode: code, errorReport, raw: { status_cd: "1", data: { status_cd: code, form_typ: "R1", action: "SAVE" } } };
  }
  const data = await callWhiteBooks("/gstr/retstatus", {
    query: { gstin, returnperiod: retPeriod, refid: referenceId, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  // WhiteBooks' own status_cd ("1") wraps GSTN's processing status.
  const d = data?.data ?? {};
  const statusCode = String(d.status_cd ?? d.status ?? "").toUpperCase() || null;
  return { statusCode, errorReport: d.error_report ?? d.errorReport ?? null, raw: data };
}

/** POST /gstr1/reset — discard all GSTR-1 data saved on the portal for the period (before proceed-to-file). */
export async function resetGstr1Data({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const ref = "MOCKREF-RST-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 1);
    mockSaved.delete(`${gstin}|${retPeriod}`);
    return { referenceId: ref, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/gstr1/reset", {
    method: "POST",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body: { gstin, ret_period: retPeriod },
  });
  return { referenceId: referenceIdOf(data), raw: data };
}

/* ============================================================
   GSTR-1 VALIDATE / PROCEED / FILE
============================================================ */

/**
 * Mock-mode behaviour switches, for tests only (ignored unless
 * GST_MOCK_MODE is on). resetMockControl() restores the happy path.
 */
export const mockControl = {};
export function resetMockControl() {
  Object.assign(mockControl, {
    saveOutcome: "P", // retstatus result after a save: "P" | "PE" | "ER"
    saveErrorReport: null,
    hsnValid: true,
    hsnErrors: null,
    tamperSummary: null, // (sec_sum) => sec_sum
    proceedOutcome: "P",
    fileError: null, // message -> the filing call fails with it (e.g. wrong OTP)
    imsSaveOutcome: "P", // ims/status after a save: "P" | "PE" | "ER"
    imsRejectInums: [], // with "PE": these invoice numbers are rejected
    imsErrorReport: null,
    gen2bOutcome: "P",
    gen2bError: null, // message -> gen2b itself is refused (e.g. too early in the month)
    tamper2b: null, // (data) => data
    tamperAutoliab: null, // (autoliab) => autoliab
    autoValidateWarnings: null, // [{ code, message }] from validateautocalculatedata
    save3bOutcome: "P",
    ledgerBalance: null, // { itc: {igst,cgst,sgst,cess}, cash: {...} }
    lateFee3b: 0,
    offsetError: null,
    file3bError: null,
    allowFileWithoutOffset: false,
    filings: null, // mock rettrack's filed returns for the current FY (null = the default list)
  });
  mockFiledReturns.length = 0;
  mockSaved.clear();
  mockImsActions.clear();
  mock3b.clear();
}
const mockSaved = new Map(); // `${gstin}|${retPeriod}` -> payload last saved (mock portal)
resetMockControl();

/** GET /gstr1/validatehsnsum — GSTN's check of the HSN table against the invoice tables. */
export async function validateHsnSummary({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    return mockControl.hsnValid
      ? { valid: true, errors: [], raw: { status_cd: "1", data: { status: "Valid" } } }
      : { valid: false, errors: mockControl.hsnErrors || [{ message: "HSN summary doesn't match the B2B / B2C values" }], raw: { status_cd: "1" } };
  }
  const data = await callWhiteBooks("/gstr1/validatehsnsum", {
    query: { gstin, retperiod: retPeriod, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  // Any error_report / error entries mean the HSN table needs fixing.
  const d = data?.data ?? {};
  const report = d.error_report ?? d.errorReport ?? d.errors ?? null;
  const errors = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.error_msg || n.errorMessage || n.error_cd) errors.push({ hsn: n.hsn_sc || null, code: n.error_cd || n.errorCode || null, message: n.error_msg || n.errorMessage || "Invalid" });
    Object.values(n).forEach((v) => v && typeof v === "object" && walk(v));
  };
  walk(report);
  const statusText = String(d.status ?? d.valid ?? "").toLowerCase();
  const valid = errors.length === 0 && !/invalid|fail|mismatch|^n$|false/.test(statusText);
  return { valid, errors, raw: data };
}

/** GET /gstr1/retsum — the portal's GSTR-1 summary. Returns its `data` object ({ chksum, sec_sum, ... }). */
export async function getGstr1Summary({ gstin, retPeriod, longSummary = false, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const { summarizePayload } = await import("./gstr1/gstr1Summary.js");
    let secSum = summarizePayload(mockSaved.get(`${gstin}|${retPeriod}`) || {});
    if (mockControl.tamperSummary) secSum = mockControl.tamperSummary(secSum);
    const chksum = crypto.createHash("sha256").update(JSON.stringify(secSum)).digest("hex");
    return { gstin, ret_period: retPeriod, chksum, newSumFlag: true, sec_sum: secSum.map((s) => ({ ...s, chksum })) };
  }
  const data = await callWhiteBooks("/gstr1/retsum", {
    query: { gstin, retperiod: retPeriod, email: whitebooksEmail, smrytyp: longSummary ? "L" : undefined },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  if (!data?.data?.sec_sum) {
    const err = new Error("GST portal returned no GSTR-1 summary (sec_sum)");
    err.details = data;
    throw err;
  }
  return data.data;
}

/** GET /all/newproceedfile — freeze the return for filing. isNil "Y" for a nil return. */
export async function proceedToFile({ gstin, retPeriod, returnType = "GSTR1", isNil = false, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const ref = "MOCKREF-PTF-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 1);
    mockRefs.set(`${ref}:outcome`, mockControl.proceedOutcome);
    return { referenceId: ref, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/all/newproceedfile", {
    query: { gstin, retperiod: retPeriod, type: returnType, isNil: isNil ? "Y" : "N", email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  const referenceId = referenceIdOf(data);
  if (!referenceId) {
    const err = new Error("GST portal accepted proceed-to-file but returned no reference id");
    err.details = data;
    throw err;
  }
  return { referenceId, raw: data };
}

/** GET /all/newretstatus — status of a proceed-to-file request. Same status codes as retstatus. */
export async function getNewReturnStatus({ gstin, retPeriod, referenceId, returnType = "GSTR1", txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const code = mockRefs.get(`${referenceId}:outcome`) || "P";
    return { statusCode: code, errorReport: code === "P" ? null : { error_msg: "Proceed to file failed (mock)" }, raw: { status_cd: "1", data: { status_cd: code } } };
  }
  const data = await callWhiteBooks("/all/newretstatus", {
    query: { gstin, returnperiod: retPeriod, refid: referenceId, rettype: returnType, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  const d = data?.data ?? {};
  return { statusCode: String(d.status_cd ?? d.status ?? "").toUpperCase() || null, errorReport: d.error_report ?? null, raw: data };
}

/** GET /authentication/otpforevc — EVC OTP to the authorised signatory. formType "R1" / "R3B". */
export async function requestEvcOtp({ gstin, pan, formType, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) return { sent: true, raw: { status_cd: "1", status_desc: "OTP sent (mock)" } };
  const data = await callWhiteBooks("/authentication/otpforevc", {
    query: { email: whitebooksEmail, gstin, pan, form_type: formType },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  return { sent: true, raw: data };
}

/**
 * POST /gstr1/retevcfile — file with the EVC OTP. Body: the portal summary's
 * `data` object (regular return) or { gstin, ret_period, isnil: "Y" }.
 * Returns the acknowledgement (ARN).
 */
export async function fileGstr1WithEvc({ gstin, retPeriod, pan, evcOtp, body, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    if (mockControl.fileError) {
      const err = new Error(`WhiteBooks: ${mockControl.fileError}`);
      err.details = { status_cd: "0", error: { errorMessage: mockControl.fileError } };
      throw err;
    }
    const arn = "AA" + retPeriod.slice(0, 2) + retPeriod.slice(4) + crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 9);
    mockFiledReturns.push({ returnPeriod: `${retPeriod.slice(0, 2)}-${retPeriod.slice(2)}`, returnType: "GSTR1", filingDate: null, arn, status: "Filed", valid: true });
    return { arn, raw: { status_cd: "1", data: { ack_num: arn } } };
  }
  const data = await callWhiteBooks("/gstr1/retevcfile", {
    method: "POST",
    query: { email: whitebooksEmail, pan, evcotp: evcOtp },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body,
  });
  const d = data?.data ?? data;
  const arn = d?.ack_num || d?.arn || d?.ackNum || data?.ack_num || null;
  if (!arn) {
    const err = new Error("GST portal returned no acknowledgement number — check the filing status on the portal before trying again");
    err.details = data;
    err.uncertain = true;
    throw err;
  }
  return { arn, raw: data };
}

/* ============================================================
   IMS SAVE + GSTR-2B GENERATION
============================================================ */

const imsKeyOf = (gstin, r) => `${gstin}|${r.stin}|${r.inum ?? r.nt_num}|${r.idt ?? r.nt_dt}`;
const yyyymm = (mmyyyy) => `${String(mmyyyy).slice(2)}${String(mmyyyy).slice(0, 2)}`;

/**
 * Request body for PUT /ims/save. Each record is the portal's own record
 * (identifying fields + hash, as GET /ims/invoices returned it) with only
 * `action` changed. Grouped by section, under the recipient GSTIN.
 * NOTE: the envelope (rtin / reqtyp / invdata) follows GSTN's IMS save API;
 * WhiteBooks' collection has no sample body — confirm on the first sandbox run.
 */
export function buildImsSaveBody(gstin, records) {
  const invdata = {};
  for (const { section, src, action } of records) {
    const key = String(section).toLowerCase();
    (invdata[key] ||= []).push({ ...src, action });
  }
  return { rtin: gstin, reqtyp: "SAVE", invdata };
}

/** PUT /ims/save — send accept / reject / pending actions. Asynchronous: poll getImsStatus(). */
export async function saveImsActions({ gstin, retPeriod, records, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  const body = buildImsSaveBody(gstin, records);
  if (MOCK_MODE) {
    const ref = "MOCKREF-IMS-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 0);
    mockRefs.set(`${ref}:outcome`, mockControl.imsSaveOutcome);
    const rejected = new Set((mockControl.imsRejectInums || []).map(String));
    if (mockControl.imsSaveOutcome !== "ER") {
      for (const r of records) if (!rejected.has(String(r.src.inum ?? r.src.nt_num))) mockImsActions.set(imsKeyOf(gstin, r.src), r.action);
    }
    return { referenceId: ref, body, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/ims/save", {
    method: "PUT",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body,
  });
  const referenceId = referenceIdOf(data);
  if (!referenceId) {
    const err = new Error("GST portal accepted the IMS save but returned no reference id");
    err.details = data;
    throw err;
  }
  return { referenceId, body, raw: data };
}

/** Shared parser for IMS / 2B status replies: GSTN's status code + error report. */
function parseProcessingStatus(data) {
  const d = data?.data ?? {};
  return { statusCode: String(d.status_cd ?? d.status ?? "").toUpperCase() || null, errorReport: d.error_report ?? d.errorReport ?? null, raw: data };
}

function mockStatus(referenceId, rejectReport) {
  const seen = mockRefs.get(referenceId) ?? 1;
  mockRefs.set(referenceId, seen + 1);
  const code = seen === 0 ? "IP" : mockRefs.get(`${referenceId}:outcome`) || "P";
  return { statusCode: code, errorReport: code === "P" || code === "IP" ? null : rejectReport, raw: { status_cd: "1", data: { status_cd: code } } };
}

/** GET /ims/status — processing status of an IMS save. */
export async function getImsStatus({ gstin, referenceId, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const report = mockControl.imsErrorReport
      || { b2b: (mockControl.imsRejectInums || []).map((inum) => ({ inum, error_cd: "IMS-E01", error_msg: "Action not allowed for this record (mock)" })) };
    return mockStatus(referenceId, report);
  }
  return parseProcessingStatus(await callWhiteBooks("/ims/status", {
    query: { gstin, int_tran_id: referenceId, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  }));
}

/**
 * PUT /gstr2b/gen2b — regenerate GSTR-2B for the period so it reflects the
 * IMS actions. Asynchronous: poll get2bStatus().
 * NOTE: body { rtin, itcprd } follows GSTN's "generate 2B on demand" API;
 * the collection has no sample — confirm on the first sandbox run.
 */
export async function generate2b({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    if (mockControl.gen2bError) {
      const err = new Error(`WhiteBooks: ${mockControl.gen2bError}`);
      err.details = { status_cd: "0", error: { errorMessage: mockControl.gen2bError } };
      throw err;
    }
    const ref = "MOCKREF-2B-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 0);
    mockRefs.set(`${ref}:outcome`, mockControl.gen2bOutcome);
    return { referenceId: ref, raw: { status_cd: "1", data: { int_tran_id: ref } } };
  }
  const data = await callWhiteBooks("/gstr2b/gen2b", {
    method: "PUT",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body: { rtin: gstin, itcprd: retPeriod },
  });
  const referenceId = referenceIdOf(data);
  if (!referenceId) {
    const err = new Error("GST portal accepted 2B generation but returned no reference id");
    err.details = data;
    throw err;
  }
  return { referenceId, raw: data };
}

/** GET /gstr2b/get2b — status of an on-demand 2B generation. */
export async function get2bStatus({ gstin, referenceId, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) return mockStatus(referenceId, { error_msg: "2B generation failed (mock)" });
  return parseProcessingStatus(await callWhiteBooks("/gstr2b/get2b", {
    query: { gstin, int_tran_id: referenceId, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  }));
}

/** Mock GSTR-2B from the IMS sample: "no action" counts as accepted, pending is left out, rejected listed apart. */
function mockGstr2b(gstin, retPeriod) {
  const zero = () => ({ txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const add = (t, r) => { t.txval += r.txval; t.igst += r.iamt; t.cgst += r.camt; t.sgst += r.samt; t.cess += r.cess; };
  const avl = zero();
  const rej = zero();
  const cpsumm = new Map();
  for (const r of loadImsSample().data.b2b) {
    if (yyyymm(r.rtnprd) > yyyymm(retPeriod)) continue;
    const action = mockImsActions.get(imsKeyOf(gstin, r)) || r.action || "N";
    if (action === "P") continue;
    if (action === "R") { add(rej, r); continue; }
    add(avl, r);
    const c = cpsumm.get(r.stin) || { ctin: r.stin, supprd: r.rtnprd, ttldocs: 0, ...zero() };
    c.ttldocs += 1; add(c, r);
    cpsumm.set(r.stin, c);
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]));
  let data = {
    gstin, rtnprd: retPeriod, version: "1.0", gendt: new Date().toLocaleDateString("en-GB").replace(/\//g, "-"),
    itcsumm: {
      itcavl: { nonrevsup: { ...round({ igst: avl.igst, cgst: avl.cgst, sgst: avl.sgst, cess: avl.cess }), b2b: round(avl) } },
      itcrej: { nonrevsup: { ...round({ igst: rej.igst, cgst: rej.cgst, sgst: rej.sgst, cess: rej.cess }), b2b: round(rej) } },
    },
    cpsumm: { b2b: [...cpsumm.values()].map(round) },
  };
  if (mockControl.tamper2b) data = mockControl.tamper2b(data);
  return { chksum: "mock", data };
}

/**
 * GET /gstr2b/all — the period's GSTR-2B. Large statements come in file
 * pages (data.fc = file count); all pages are fetched and their document
 * lists merged. Returns the inner data object ({ itcsumm, cpsumm, docdata, ... }).
 */
export async function getGstr2b({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) return mockGstr2b(gstin, retPeriod).data;
  const get = (filenum) => callWhiteBooks("/gstr2b/all", {
    query: { gstin, rtnprd: retPeriod, filenum, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  const first = await get(undefined);
  const inner = first?.data?.data ?? first?.data;
  if (!inner?.itcsumm) {
    const err = new Error("GST portal returned no GSTR-2B summary (itcsumm) — has 2B been generated for this period?");
    err.details = first;
    throw err;
  }
  const fileCount = Number(inner.fc || first?.data?.fc || 1);
  for (let n = 2; n <= fileCount; n++) {
    const page = await get(n);
    const pd = page?.data?.data ?? page?.data;
    for (const [sec, list] of Object.entries(pd?.docdata || {})) {
      if (Array.isArray(list)) (inner.docdata ||= {})[sec] = [...(inner.docdata?.[sec] || []), ...list];
    }
  }
  return inner;
}

/* ============================================================
   GSTR-3B: CHECK, SAVE, LEDGERS, OFFSET, FILE
============================================================ */

const TRANS_OTHER = 30002; // liability "other than reverse charge"
const TRANS_RCM = 30003; // liability on reverse charge
const heads4 = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

/**
 * GET /gstr3b/autoliab — the portal's auto-calculated 3B (liability from
 * GSTR-1, ITC from GSTR-2B). Returns the inner data object as received.
 */
export async function getGstr3bAutoLiability({ gstin, retPeriod, mockBasis, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const saved = mock3b.get(`${gstin}|${retPeriod}`)?.payload || mockBasis; // mock: the portal agrees with the books
    let data = saved ? { gstin, ret_period: retPeriod, sup_details: saved.sup_details, itc_elg: saved.itc_elg, inter_sup: saved.inter_sup } : { gstin, ret_period: retPeriod };
    if (mockControl.tamperAutoliab) data = mockControl.tamperAutoliab(data);
    return data;
  }
  const data = await callWhiteBooks("/gstr3b/autoliab", {
    query: { gstin, retperiod: retPeriod, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  return data?.data ?? data;
}

/**
 * POST /gstr3b/validateautocalculatedata — GSTN's check of the 3B against
 * its auto-calculated values (e.g. liability declared lower, ITC above 2B).
 * Returns { ok, warnings: [{ code, message }] }.
 */
export async function validateGstr3bAgainstAuto({ gstin, retPeriod, payload, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const warnings = mockControl.autoValidateWarnings || [];
    return { ok: warnings.length === 0, warnings, raw: { status_cd: "1" } };
  }
  const data = await callWhiteBooks("/gstr3b/validateautocalculatedata", {
    method: "POST",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body: payload,
  });
  const warnings = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const msg = n.error_msg || n.errorMessage || n.message || n.msg;
    if (msg && (n.error_cd || n.errorCode || n.code || n.error_msg || n.errorMessage)) warnings.push({ code: n.error_cd || n.errorCode || n.code || null, message: msg });
    Object.values(n).forEach((v) => v && typeof v === "object" && walk(v));
  };
  walk(data?.data);
  return { ok: warnings.length === 0, warnings, raw: data };
}

/** PUT /gstr3b/retsave — save GSTR-3B. Returns a reference id when GSTN processes it asynchronously. */
export async function saveGstr3bData({ gstin, retPeriod, payload, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const k = `${gstin}|${retPeriod}`;
    mock3b.set(k, { ...(mock3b.get(k) || {}), payload, offset: null });
    const ref = "MOCKREF-3B-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 0);
    mockRefs.set(`${ref}:outcome`, mockControl.save3bOutcome);
    return { referenceId: ref, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/gstr3b/retsave", {
    method: "PUT",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body: payload,
  });
  return { referenceId: referenceIdOf(data), raw: data };
}

/**
 * GET /gstr3b/retsum — the portal's GSTR-3B. Its tx_pmt.tx_py lists the
 * liability per ledger (liab_ldg_id + trans_typ), needed for the offset;
 * after offset, its data object is the filing body.
 */
export async function getGstr3bSummary({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const state = mock3b.get(`${gstin}|${retPeriod}`);
    if (!state?.payload) return { gstin, ret_period: retPeriod };
    const out = state.payload.sup_details.osup_det;
    const rcm = state.payload.sup_details.isup_rev;
    const fee = mockControl.lateFee3b || 0;
    const tx = (o, ldg, typ, desc, withFee) => ({
      trans_typ: typ, trans_desc: desc, liab_ldg_id: ldg,
      igst: { tx: o.iamt || 0, intr: 0 }, cgst: { tx: o.camt || 0, intr: 0, fee: withFee ? fee / 2 : 0 },
      sgst: { tx: o.samt || 0, intr: 0, fee: withFee ? fee / 2 : 0 }, cess: { tx: o.csamt || 0, intr: 0 },
    });
    return {
      ...state.payload,
      chksum: crypto.createHash("sha256").update(JSON.stringify(state.payload) + JSON.stringify(state.offset)).digest("hex"),
      tx_pmt: {
        tx_py: [tx(out, 11191, TRANS_OTHER, "Other than reverse charge", true), tx(rcm, 11192, TRANS_RCM, "Reverse charge", false)],
        ...(state.offset ? { pdcash: state.offset.pdcash, pditc: state.offset.pditc } : {}),
      },
    };
  }
  const data = await callWhiteBooks("/gstr3b/retsum", {
    query: { gstin, retperiod: retPeriod, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  if (!data?.data) {
    const err = new Error("GST portal returned no GSTR-3B summary");
    err.details = data;
    throw err;
  }
  return data.data;
}

/**
 * GET /ledgers/bal — electronic cash and credit ledger balances.
 * Normalised to { itc: {igst,cgst,sgst,cess}, cash: {igst,cgst,sgst,cess} }
 * (cash = the tax minor head available per major head).
 */
export async function getLedgerBalances({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const b = mockControl.ledgerBalance || { itc: heads4(), cash: heads4() };
    return { itc: { ...heads4(), ...b.itc }, cash: { ...heads4(), ...b.cash }, raw: { status_cd: "1" } };
  }
  const data = await callWhiteBooks("/ledgers/bal", {
    query: { gstin, retperiod: retPeriod, email: whitebooksEmail },
    headers: authHeaders({ gstin, gstUsername, ipAddress, txn, clientId, clientSecret }),
  });
  const d = data?.data ?? {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // itc_bal: { igst_bal, cgst_bal, sgst_bal, cess_bal }; cash_bal: { igst: { tx, ... } | igst_tot_bal ... }
  const itcB = d.itc_bal || d.itcBal || {};
  const cashB = d.cash_bal || d.cashBal || {};
  const cashHead = (h) => n(cashB[h]?.tx ?? cashB[`${h}_tx`] ?? cashB[h]?.tot ?? cashB[`${h}_tot_bal`] ?? cashB[h]);
  return {
    itc: { igst: n(itcB.igst_bal ?? itcB.igst), cgst: n(itcB.cgst_bal ?? itcB.cgst), sgst: n(itcB.sgst_bal ?? itcB.sgst), cess: n(itcB.cess_bal ?? itcB.cess) },
    cash: { igst: cashHead("igst"), cgst: cashHead("cgst"), sgst: cashHead("sgst"), cess: cashHead("cess") },
    raw: data,
  };
}

/** PUT /gstr3b/retoffset — pay the liability from the credit and cash ledgers. Irreversible. */
export async function offsetGstr3bLiability({ gstin, retPeriod, body, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    const bal = mockControl.ledgerBalance?.cash || heads4();
    const need = body.pdcash.reduce((a, p) => ({ igst: a.igst + p.ipd + (p.i_intrpd || 0), cgst: a.cgst + p.cpd + (p.c_intrpd || 0) + (p.c_lfeepd || 0), sgst: a.sgst + p.spd + (p.s_intrpd || 0) + (p.s_lfeepd || 0), cess: a.cess + p.cspd + (p.cs_intrpd || 0) }), heads4());
    const short = Object.keys(need).find((h) => need[h] - (bal[h] || 0) > 0.005);
    if (short || mockControl.offsetError) {
      const msg = mockControl.offsetError || `Insufficient balance in electronic cash ledger (${short.toUpperCase()})`;
      const err = new Error(`WhiteBooks: ${msg}`);
      err.details = { status_cd: "0", error: { errorMessage: msg } };
      throw err;
    }
    const k = `${gstin}|${retPeriod}`;
    mock3b.set(k, { ...mock3b.get(k), offset: body });
    const ref = "MOCKREF-OFS-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    mockRefs.set(ref, 1);
    return { referenceId: ref, raw: { status_cd: "1", data: { reference_id: ref } } };
  }
  const data = await callWhiteBooks("/gstr3b/retoffset", {
    method: "PUT",
    query: { email: whitebooksEmail },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body,
  });
  return { referenceId: referenceIdOf(data), raw: data };
}

/** POST /gstr3b/retevcfile — file with EVC; body = the summary's data object after offset. */
export async function fileGstr3bWithEvc({ gstin, retPeriod, pan, evcOtp, body, txn, gstUsername, ipAddress, clientId, clientSecret, whitebooksEmail }) {
  if (MOCK_MODE) {
    if (mockControl.file3bError) {
      const err = new Error(`WhiteBooks: ${mockControl.file3bError}`);
      err.details = { status_cd: "0", error: { errorMessage: mockControl.file3bError } };
      throw err;
    }
    const state = mock3b.get(`${gstin}|${retPeriod}`);
    const o = state?.payload?.sup_details?.osup_det || {};
    const payable = (o.iamt || 0) + (o.camt || 0) + (o.samt || 0) + (o.csamt || 0) + (mockControl.lateFee3b || 0);
    if (payable > 0 && !state?.offset && !mockControl.allowFileWithoutOffset) {
      const err = new Error("WhiteBooks: Liability not offset");
      err.details = { status_cd: "0", error: { errorMessage: "Liability not offset" } };
      throw err;
    }
    const arn = "AB" + retPeriod.slice(0, 2) + retPeriod.slice(4) + crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 9);
    mockFiledReturns.push({ returnPeriod: `${retPeriod.slice(0, 2)}-${retPeriod.slice(2)}`, returnType: "GSTR3B", filingDate: null, arn, status: "Filed", valid: true });
    return { arn, raw: { status_cd: "1", data: { ack_num: arn } } };
  }
  const data = await callWhiteBooks("/gstr3b/retevcfile", {
    method: "POST",
    query: { email: whitebooksEmail, pan, evcotp: evcOtp },
    headers: returnHeaders({ gstin, retPeriod, txn, gstUsername, ipAddress, clientId, clientSecret }),
    body,
  });
  const d = data?.data ?? data;
  const arn = d?.ack_num || d?.arn || d?.ackNum || data?.ack_num || null;
  if (!arn) {
    const err = new Error("GST portal returned no acknowledgement number — check the filing status on the portal before trying again");
    err.details = data;
    err.uncertain = true;
    throw err;
  }
  return { arn, raw: data };
}

export const isMockMode = MOCK_MODE;