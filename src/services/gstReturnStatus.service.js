// src/services/gstReturnStatus.service.js
//
// Phase 2: filing preference (Monthly/Quarterly per quarter) + already-
// filed return history. Runs off client_id/client_secret/whitebooksEmail
// already stored in gst_credentials from Phase 1 — no OTP/auth_token
// needed, since /public/pref and /public/rettrack don't require an
// authenticated session.

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { decrypt } from "../utils/encryption.js";
import * as whitebooks from "./whitebooks.service.js";

/**
 * QRMP (Monthly/Quarterly filing preference) did not exist before FY
 * 2020-21 — WhiteBooks rejects the call every time for earlier years, so
 * skip it rather than waste a request and surface a confusing error.
 */
function isPrefSupportedYear(financialYear) {
  const startYear = parseInt(String(financialYear).slice(0, 4), 10);
  return Number.isFinite(startYear) && startYear >= 2020;
}

/**
 * Runs both WhiteBooks checks (filing preference + already-filed return
 * history), stores a new row in gst_return_status (kept as history, not
 * overwritten), and returns a normalized response for the frontend.
 */
export const checkReturnStatus = async ({ companyId, gstin, financialYear, returnType }) => {
  const { rows: credRows } = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  const creds = credRows[0];
  if (!creds) {
    return { error: "GST credentials not found for this company/gstin — complete GST login first", code: 400 };
  }
  if (!creds.whitebooks_email) {
    return { error: "No whitebooks_email stored for this company/gstin", code: 400 };
  }

  const clientSecret = decrypt(creds.client_secret_enc);
  const prefSupported = isPrefSupportedYear(financialYear);

  const [prefResult, trackResult] = await Promise.all([
    prefSupported
      ? whitebooks
          .getFilingPreference({
            gstin,
            financialYear,
            clientId: creds.client_id,
            clientSecret,
            whitebooksEmail: creds.whitebooks_email,
          })
          .catch((err) => ({ error: err }))
      : Promise.resolve({ notApplicable: true }),
    whitebooks
      .trackReturnStatus({
        gstin,
        financialYear,
        returnType,
        clientId: creds.client_id,
        clientSecret,
        whitebooksEmail: creds.whitebooks_email,
      })
      .catch((err) => ({ error: err })),
  ]);

  const prefFailed = prefResult?.error;
  const prefNotApplicable = prefResult?.notApplicable;
  const trackFailed = trackResult?.error;

  const filings = trackFailed ? [] : trackResult.filings || [];
  const preferences = prefFailed || prefNotApplicable ? null : prefResult.preferences;

  const distinctFrequencies = preferences ? [...new Set(preferences.map((p) => p.frequency))] : [];
  const frequency = distinctFrequencies.length === 1 ? distinctFrequencies[0] : null;

  // rettrack's EFiledlist is a direct record of already-filed returns —
  // a better source for "was a previous return filed" than /public/pref
  // (which is only a Monthly/Quarterly preference setting, not a filed
  // status). true if WhiteBooks returned at least one filed entry.
  const previousReturnFiled = trackFailed ? null : filings.length > 0;

  // Most recent filing by date, if any — useful as a quick summary without
  // the frontend needing to sort the full list itself.
  const latestFiling =
    filings.length > 0
      ? [...filings].sort((a, b) => new Date(b.filingDate?.split("-").reverse().join("-")) - new Date(a.filingDate?.split("-").reverse().join("-")))[0]
      : null;

  const status = trackFailed ? "CHECK_FAILED" : filings.length > 0 ? "HAS_FILED_RETURNS" : "NO_RETURNS_FOUND";

  const rawResponse = {
    pref: prefNotApplicable
      ? { skipped: true, reason: "Filing preference data does not exist before FY 2020-21" }
      : prefFailed
      ? { error: prefResult.error.message, details: prefResult.error.details }
      : prefResult.raw,
    rettrack: trackFailed ? { error: trackResult.error.message, details: trackResult.error.details } : trackResult.raw,
  };

  const { rows } = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_return_status
      (company_id, gstin, financial_year, return_period, frequency, previous_return_filed, status, raw_response, checked_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    RETURNING id
    `,
    [companyId, gstin, financialYear, latestFiling?.returnPeriod || null, frequency, previousReturnFiled, status, JSON.stringify(rawResponse)]
  );

  return {
    id: rows[0].id,
    gstin,
    financialYear,
    frequency,
    preferences, // per-quarter breakdown, e.g. [{quarter:"Q1", frequency:"MONTHLY"}, ...]
    preferenceNotApplicable: prefNotApplicable || false,
    previousReturnFiled,
    filings, // full list: [{returnPeriod, returnType, filingDate, arn, status, valid}, ...]
    latestFiling,
    status,
    prefError: prefFailed ? prefResult.error.message : null,
    trackError: trackFailed ? trackResult.error.message : null,
  };
};

/**
 * Latest stored check for a company/gstin, without hitting WhiteBooks again.
 */
export const getLatestReturnStatus = async ({ companyId, gstin }) => {
  const { rows } = await pool.query(
    `
    SELECT * FROM ${DB_SCHEMA}.gst_return_status
    WHERE company_id = $1 AND gstin = $2
    ORDER BY id DESC LIMIT 1
    `,
    [companyId, gstin]
  );
  const row = rows[0];
  if (!row) {
    return { found: false };
  }
  return {
    found: true,
    financialYear: row.financial_year,
    returnPeriod: row.return_period,
    frequency: row.frequency,
    previousReturnFiled: row.previous_return_filed,
    status: row.status,
    checkedAt: row.checked_at,
  };
};