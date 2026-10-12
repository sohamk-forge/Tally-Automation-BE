// src/services/gstReturnStatus.service.js
//
// Phase 2: filing preference (Monthly/Quarterly per quarter) + already-
// filed return history. Runs off the platform WhiteBooks config from .env
// (getWhiteBooksConfig) — no OTP/auth_token
// needed, since /public/pref and /public/rettrack don't require an
// authenticated session.

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
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

/** "2026-27" for any date from Apr 2026 to Mar 2027. */
export function currentFinancialYear(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return fyLabel(y);
}

const fyLabel = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
const fyStartYear = (financialYear) => parseInt(String(financialYear).slice(0, 4), 10);
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDayOf = (y, m) => new Date(y, m, 0).getDate();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUARTERS = [["Q1", [4, 5, 6]], ["Q2", [7, 8, 9]], ["Q3", [10, 11, 12]], ["Q4", [1, 2, 3]]];

/** rettrack's rtntype ("GSTR1", "GSTR-3B", "R1", ...) -> "GSTR1" | "GSTR3B" | other. */
function normalizeReturnType(type) {
  const t = String(type || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t === "GSTR1" || t === "R1") return "GSTR1";
  if (t === "GSTR3B" || t === "R3B") return "GSTR3B";
  return t;
}

/** "MM-YYYY" -> { GSTR1: filing, GSTR3B: filing } */
function indexFilings(filings) {
  const byPeriod = {};
  for (const f of filings || []) {
    if (!f.returnPeriod) continue;
    (byPeriod[f.returnPeriod] ||= {})[normalizeReturnType(f.returnType)] = f;
  }
  return byPeriod;
}

/** "01/07/2017" (GSTN search) -> "2017-07-01", or null. */
function parseGstnDate(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Every return period of a financial year, honouring the per-quarter
 * Monthly/Quarterly preference: a QUARTERLY quarter is one period keyed by
 * its last month (GSTN convention, e.g. Q2 -> "09-2026" / retPeriod
 * "092026"); a MONTHLY quarter is three.
 *
 * Each period carries its date range (used to fetch vouchers and on every
 * later GSTN call), its GSTR-1 / GSTR-3B filed state, and whether it can be
 * worked on now. Hard locks:
 *   - only the earliest period that isn't fully filed is open: GSTR-1 must be
 *     filed in sequence, and GSTR-1 needs the previous period's GSTR-3B;
 *   - `carriedLock` (previous FY unfinished, unreadable history, inactive
 *     GSTIN) locks the whole year.
 * Left out entirely: periods not over yet, periods that ended before the
 * GSTIN was registered, and periods time-barred (3 years past the due date).
 */
export function buildPeriods({ financialYear, preferences, filings, registrationDate = null, carriedLock = null, now = new Date() }) {
  const startYear = fyStartYear(financialYear);
  const prefByQuarter = Object.fromEntries((preferences || []).map((p) => [p.quarter, p.frequency]));
  const filedByPeriod = indexFilings(filings);
  const filedState = (f) => (f ? { filed: true, arn: f.arn || null, filingDate: f.filingDate || null } : { filed: false });

  const periods = [];
  for (const [quarter, months] of QUARTERS) {
    const year = quarter === "Q4" ? startYear + 1 : startYear;
    const frequency = prefByQuarter[quarter] === "QUARTERLY" ? "QUARTERLY" : "MONTHLY";
    const spans = frequency === "QUARTERLY"
      ? [{ first: months[0], last: months[2], label: `${quarter} (${MONTHS[months[0] - 1]}–${MONTHS[months[2] - 1]} ${year})` }]
      : months.map((m) => ({ first: m, last: m, label: `${MONTHS[m - 1]} ${year}` }));

    for (const { first, last, label } of spans) {
      const toDate = isoDate(year, last, lastDayOf(year, last));
      if (new Date(year, last, 1) > now) continue; // not over yet
      if (registrationDate && toDate < registrationDate) continue; // before registration
      // GSTR-1 is due on the 11th (monthly) / 13th (quarterly) of the next
      // month; GSTN refuses returns more than 3 years after that.
      const due = new Date(year, last, frequency === "QUARTERLY" ? 13 : 11);
      if (now > new Date(due.getFullYear() + 3, due.getMonth(), due.getDate())) continue;

      const period = `${pad2(last)}-${year}`;
      const gstr1 = filedState(filedByPeriod[period]?.GSTR1);
      const gstr3b = filedState(filedByPeriod[period]?.GSTR3B);
      periods.push({
        period, // "MM-YYYY", our key
        retPeriod: `${pad2(last)}${year}`, // "MMYYYY", sent to GSTN
        label,
        quarter,
        frequency,
        financialYear,
        fromDate: isoDate(year, first, 1),
        toDate,
        gstr1,
        gstr3b,
        status: gstr3b.filed ? "FILED" : gstr1.filed ? "GSTR1_FILED" : "OPEN",
      });
    }
  }

  let lock = carriedLock;
  for (const p of periods) {
    if (p.status === "FILED") {
      p.available = false;
      p.lockReason = null;
      continue;
    }
    p.available = !lock;
    p.lockReason = lock;
    if (!lock) {
      lock = p.status === "GSTR1_FILED"
        ? `GSTR-3B for ${p.label} is pending. Finish ${p.label} first.`
        : `File ${p.label} first. GSTR-1 must be filed in sequence.`;
    }
  }
  return periods;
}

/**
 * Lock carried into `financialYear` from the year before: if that year's
 * last period isn't fully filed, nothing in this year can be filed.
 * Skipped when the GSTIN was registered after that year ended, or when the
 * earlier year shows no filings at all (not registered then).
 */
async function previousYearLock({ financialYear, gstin, registrationDate, config }) {
  const prevStart = fyStartYear(financialYear) - 1;
  const prevFy = fyLabel(prevStart);
  if (registrationDate && registrationDate > isoDate(prevStart + 1, 3, 31)) return { lock: null };

  let filings;
  try {
    ({ filings } = await whitebooks.trackReturnStatus({ gstin, financialYear: prevFy, ...config }));
  } catch (err) {
    return { lock: `Couldn't check FY ${prevFy} returns on the GST portal. Retry before filing.`, error: err.message };
  }
  if (!filings?.length) return { lock: null };

  const march = indexFilings(filings)[`03-${prevStart + 1}`] || {};
  if (march.GSTR1 && march.GSTR3B) return { lock: null };
  const missing = !march.GSTR1 ? "GSTR-1" : "GSTR-3B";
  return { lock: `${missing} for Mar ${prevStart + 1} (FY ${prevFy}) isn't filed. Switch to FY ${prevFy} and finish it first.` };
}

/**
 * Composition dealers file CMP-08/GSTR-4 instead of GSTR-1/3B. Taken from
 * the GST portal's taxpayer record, else the Tally-synced registration
 * type, else inferred from rettrack history.
 */
async function resolveRegime(companyId, filings, taxpayerType) {
  if (/composition/i.test(taxpayerType || "")) return "COMPOSITION";
  if (taxpayerType) return "REGULAR";
  const { rows } = await pool.query(
    `SELECT gst_registration_type FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
    [companyId]
  );
  const regType = rows[0]?.gst_registration_type || "";
  if (/composition/i.test(regType)) return "COMPOSITION";
  if (filings.some((f) => ["CMP08", "GSTR4"].includes(normalizeReturnType(f.returnType)))) return "COMPOSITION";
  return "REGULAR";
}

/**
 * Builds the "which return can be filed" picture for one financial year:
 * filing preference, filed returns (this FY, plus the previous one for the
 * carried lock), the taxpayer's registration record, and the resulting
 * periods with their locks. Stores a row in gst_return_status as history.
 */
export const checkReturnStatus = async ({ companyId, gstin, financialYear, returnType }) => {
  financialYear = financialYear || currentFinancialYear();
  if (!/^\d{4}-\d{2}$/.test(financialYear) || fyStartYear(financialYear) > fyStartYear(currentFinancialYear())) {
    return { error: `Invalid financial year ${financialYear}`, code: 400 };
  }
  const { rows: credRows } = await pool.query(
    `SELECT 1 FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  if (!credRows[0]) {
    return { error: "GST credentials not found for this company/gstin — complete GST login first", code: 400 };
  }
  const { clientId, clientSecret, whitebooksEmail, ipAddress } = whitebooks.getWhiteBooksConfig();
  const config = { clientId, clientSecret, whitebooksEmail };
  const prefSupported = isPrefSupportedYear(financialYear);

  const [prefResult, trackResult, taxpayerResult] = await Promise.all([
    prefSupported
      ? whitebooks.getFilingPreference({ gstin, financialYear, ...config, ipAddress }).catch((err) => ({ error: err }))
      : Promise.resolve({ notApplicable: true }),
    whitebooks.trackReturnStatus({ gstin, financialYear, returnType, ...config }).catch((err) => ({ error: err })),
    whitebooks.searchTaxpayer({ gstin, ...config }).catch((err) => ({ error: err })),
  ]);

  const prefFailed = prefResult?.error;
  const prefNotApplicable = prefResult?.notApplicable;
  const trackFailed = trackResult?.error;
  const taxpayerFailed = taxpayerResult?.error;

  const filings = trackFailed ? [] : trackResult.filings || [];
  const preferences = prefFailed || prefNotApplicable ? null : prefResult.preferences;
  const taxpayer = taxpayerFailed ? null : taxpayerResult;
  const registrationDate = parseGstnDate(taxpayer?.registrationDate);

  const distinctFrequencies = preferences ? [...new Set(preferences.map((p) => p.frequency))] : [];
  const frequency = distinctFrequencies.length === 1 ? distinctFrequencies[0] : null;

  // Hard locks: no readable filing history -> nothing can be filed; an
  // inactive GSTIN can't file; otherwise the previous FY must be finished.
  let carriedLock = null;
  let prevYearError = null;
  if (trackFailed) {
    carriedLock = "Couldn't read filed returns from the GST portal. Retry before filing.";
  } else if (taxpayer?.status && !/^active$/i.test(taxpayer.status)) {
    carriedLock = `GSTIN status on the GST portal is "${taxpayer.status}", so returns can't be filed.`;
  } else {
    const prev = await previousYearLock({ financialYear, gstin, registrationDate, config });
    carriedLock = prev.lock;
    prevYearError = prev.error || null;
  }

  const periods = buildPeriods({ financialYear, preferences, filings, registrationDate, carriedLock });
  const regime = await resolveRegime(companyId, filings, taxpayer?.taxpayerType);

  const previousReturnFiled = trackFailed ? null : filings.length > 0;
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
    search: taxpayerFailed ? { error: taxpayerResult.error.message } : taxpayerResult.raw,
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

  const current = currentFinancialYear();
  return {
    id: rows[0].id,
    gstin,
    financialYear,
    financialYears: [current, fyLabel(fyStartYear(current) - 1)], // FYs the user can switch between
    regime, // "REGULAR" | "COMPOSITION"
    frequency, // "MONTHLY" | "QUARTERLY" | null (mixed across quarters or pref unavailable)
    periods, // [{ period, retPeriod, label, quarter, frequency, financialYear, fromDate, toDate, gstr1, gstr3b, status, available, lockReason }]
    nextPeriod: periods.find((p) => p.available)?.period || null,
    blockedReason: carriedLock,
    registrationDate,
    taxpayer: taxpayer ? { legalName: taxpayer.legalName, tradeName: taxpayer.tradeName, status: taxpayer.status, type: taxpayer.taxpayerType } : null,
    preferences, // per-quarter breakdown, e.g. [{quarter:"Q1", frequency:"MONTHLY"}, ...]
    preferenceNotApplicable: prefNotApplicable || false,
    previousReturnFiled,
    filings, // full list: [{returnPeriod, returnType, filingDate, arn, status, valid}, ...]
    latestFiling,
    status,
    prefError: prefFailed ? prefResult.error.message : null,
    trackError: trackFailed ? trackResult.error.message : null,
    taxpayerError: taxpayerFailed ? taxpayerResult.error.message : null,
    prevYearError,
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