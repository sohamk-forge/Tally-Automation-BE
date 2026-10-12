// src/services/gstr1/gstr1Prepare.service.js
//
// Stage 1 of the GSTR-1 pipeline ("Prepare"): load the period's sales
// vouchers and the masters they need, run the pure builder + schema
// validator, and store the result as the period's run in gst_gstr1_runs.
// No GSTN / WhiteBooks call happens here.

import crypto from "crypto";
import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import { buildGstr1, normName } from "./gstr1Builder.js";
import { validateGstr1Payload } from "./gstr1Validator.js";

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * The period is identified by its GSTN code + frequency; dates are derived
 * here rather than trusted from the client. Quarterly periods are keyed by
 * the quarter's last month.
 */
export function resolvePeriod({ retPeriod, frequency }) {
  const m = /^(0[1-9]|1[0-2])(\d{4})$/.exec(String(retPeriod || ""));
  if (!m) return null;
  const last = Number(m[1]);
  const year = Number(m[2]);
  const quarterly = frequency === "QUARTERLY";
  if (quarterly && last % 3 !== 0) return null;
  const first = quarterly ? last - 2 : last;
  const fyStart = last >= 4 ? year : year - 1;
  return {
    retPeriod: `${pad2(last)}${year}`,
    period: `${pad2(last)}-${year}`,
    frequency: quarterly ? "QUARTERLY" : "MONTHLY",
    financialYear: `${fyStart}-${pad2((fyStart + 1) % 100)}`,
    fromDate: `${year}-${pad2(first)}-01`,
    toDate: `${year}-${pad2(last)}-${pad2(new Date(year, last, 0).getDate())}`,
  };
}

export async function loadInputs(companyId, period) {
  const [vouchers, ledgers, sgs, psi, groups, overrides] = await Promise.all([
    pool.query(
      `
      SELECT id, voucher_type, voucher_number, party_ledger_name, ledger_entries,
             party_gstin, place_of_supply, is_cancelled, is_optional,
             to_char(voucher_date, 'DD-MM-YYYY') AS idt,
             to_char(voucher_date, 'YYYY-MM-DD') AS date
      FROM ${DB_SCHEMA}.vouchers
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND voucher_date BETWEEN $2 AND $3
        AND voucher_type !~* 'order'
        AND (voucher_type ~* 'sales|credit\\s*note|debit\\s*note|invoice')
      ORDER BY voucher_date, id
      `,
      [companyId, period.fromDate, period.toDate]
    ),
    pool.query(
      `SELECT ledger_name, gst_number, state, country, parent_group, gst_registration_type
       FROM ${DB_SCHEMA}.all_ledger_details WHERE company_id = $1 AND deleted_at IS NULL`,
      [companyId]
    ),
    pool.query(
      `SELECT item_name, group_name, hsn_code, gst_rate, igst_rate, unit
       FROM ${DB_SCHEMA}.stock_group_summary WHERE company_id = $1 AND deleted_at IS NULL`,
      [companyId]
    ),
    pool.query(
      `SELECT item_name, hsn_code, igst_rate, unit_name FROM ${DB_SCHEMA}.push_stock_item WHERE company_id = $1`,
      [companyId]
    ),
    pool.query(
      `SELECT group_name, hsn_code, igst_rate FROM ${DB_SCHEMA}.stock_group_gst_details WHERE company_id = $1`,
      [companyId]
    ),
    pool.query(
      `SELECT item_name, item_key, hsn_code, gst_rate, uqc FROM ${DB_SCHEMA}.gst_item_hsn_overrides WHERE company_id = $1`,
      [companyId]
    ),
  ]);

  const ledgerMap = new Map(ledgers.rows.map((l) => [normName(l.ledger_name), l]));

  // Item GST details: pushed item -> stock summary -> stock group. A rate of
  // 0 in these masters means "not synced", not "nil rated".
  const groupMap = new Map(groups.rows.map((g) => [normName(g.group_name), g]));
  const pushMap = new Map(psi.rows.map((p) => [normName(p.item_name), p]));
  const itemMap = new Map();
  for (const s of sgs.rows) {
    const key = normName(s.item_name);
    const p = pushMap.get(key);
    const g = groupMap.get(normName(s.group_name));
    const hsn = [p?.hsn_code, s.hsn_code, g?.hsn_code].map((h) => String(h || "").trim()).find(Boolean) || null;
    const rate = [p?.igst_rate, s.igst_rate, s.gst_rate, g?.igst_rate].map(Number).find((r) => r > 0) || null;
    itemMap.set(key, {
      hsn,
      rate,
      unit: s.unit || p?.unit_name || null,
      source: p?.hsn_code ? "pushed item" : s.hsn_code ? "stock item" : g?.hsn_code ? "stock group" : null,
    });
  }
  for (const [key, p] of pushMap) {
    if (!itemMap.has(key)) itemMap.set(key, { hsn: p.hsn_code || null, rate: Number(p.igst_rate) > 0 ? Number(p.igst_rate) : null, unit: p.unit_name, source: "pushed item" });
  }

  const overrideMap = new Map(overrides.rows.map((o) => [o.item_key, o]));
  return { vouchers: vouchers.rows, ledgers: ledgerMap, items: itemMap, overrides: overrideMap };
}

/** Build + validate + store. Returns the stored run. */
export async function prepareGstr1({ companyId, gstin, retPeriod, frequency, createdBy }) {
  const period = resolvePeriod({ retPeriod, frequency });
  if (!period) {
    const err = new Error("Invalid return period — expected retPeriod MMYYYY (a quarter's last month for QUARTERLY)");
    err.code = 400;
    throw err;
  }

  const { rows: credRows } = await pool.query(
    `SELECT hsn_min_digits FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  if (!credRows[0]) {
    const err = new Error("GST credentials not found for this company/gstin — complete GST login first");
    err.code = 400;
    throw err;
  }

  const existing = await getRun({ companyId, gstin, period: period.period });
  // Rebuilding after a save is fine (save again to update the portal);
  // not while a save is processing or once the return is frozen for filing.
  if (existing && !["PREPARED", "SAVE_FAILED", "SAVED", "VALIDATED", "PROCEED_FAILED"].includes(existing.stage)) {
    const err = new Error(`GSTR-1 for ${period.period} is at stage ${existing.stage} — it can't be rebuilt now`);
    err.code = 409;
    throw err;
  }

  const inputs = await loadInputs(companyId, period);
  const result = buildGstr1({
    supplierGstin: gstin,
    period,
    ...inputs,
    options: { hsnMinDigits: credRows[0].hsn_min_digits || 6 },
  });

  // Schema check only once the builder itself found nothing blocking —
  // otherwise its errors would just repeat the builder's in schema terms.
  if (result.stats.errors === 0 && !result.stats.isNil) {
    const schemaIssues = validateGstr1Payload(result.payload);
    result.issues.push(...schemaIssues);
    result.stats.errors += schemaIssues.length;
  }

  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(result.payload)).digest("hex");

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_gstr1_runs
      (company_id, gstin, financial_year, return_period, ret_period, from_date, to_date, frequency,
       stage, payload, payload_hash, sections, invoices, excluded, issues, stats,
       error_count, warning_count, prepared_at, created_by, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED',$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18,now())
    ON CONFLICT (company_id, gstin, return_period) DO UPDATE SET
      stage = 'PREPARED', validation = NULL,
      payload = EXCLUDED.payload, payload_hash = EXCLUDED.payload_hash,
      sections = EXCLUDED.sections, invoices = EXCLUDED.invoices, excluded = EXCLUDED.excluded,
      issues = EXCLUDED.issues, stats = EXCLUDED.stats,
      error_count = EXCLUDED.error_count, warning_count = EXCLUDED.warning_count,
      prepared_at = now(), updated_at = now()
    `,
    [
      companyId, gstin, period.financialYear, period.period, period.retPeriod, period.fromDate, period.toDate, period.frequency,
      JSON.stringify(result.payload), payloadHash, JSON.stringify(result.sections), JSON.stringify(result.invoices),
      JSON.stringify(result.excluded), JSON.stringify(result.issues), JSON.stringify(result.stats),
      result.stats.errors, result.stats.warnings, createdBy || null,
    ]
  );

  return getRun({ companyId, gstin, period: period.period });
}

/** The stored run for a period, or null. */
export async function getRun({ companyId, gstin, period }) {
  const { rows } = await pool.query(
    `
    SELECT id, gstin, financial_year, return_period, ret_period,
           to_char(from_date, 'YYYY-MM-DD') AS from_date, to_char(to_date, 'YYYY-MM-DD') AS to_date,
           frequency, stage, payload, payload_hash, sections, invoices, excluded, issues, stats,
           error_count, warning_count, prepared_at, save_ref_id, save_status, validation, proceed_ref_id, proceed_status, final_summary, file_status, arn, filed_at
    FROM ${DB_SCHEMA}.gst_gstr1_runs
    WHERE company_id = $1 AND gstin = $2 AND return_period = $3
    `,
    [companyId, gstin, period]
  );
  return rows[0] || null;
}

/** Upsert in-app HSN / rate / UQC for items or ledgers. */
export async function saveHsnOverrides({ companyId, overrides, updatedBy }) {
  const saved = [];
  for (const o of overrides) {
    const name = String(o.itemName || "").trim();
    const hsn = o.hsnCode ? String(o.hsnCode).replace(/\s+/g, "") : null;
    const rate = o.gstRate === "" || o.gstRate == null ? null : Number(o.gstRate);
    const uqc = o.uqc ? String(o.uqc).trim().toUpperCase() : null;
    if (!name) continue;
    if (hsn && !/^(\d{2}|\d{4}|\d{6}|\d{8})$/.test(hsn)) {
      const err = new Error(`HSN "${o.hsnCode}" for ${name} must be 2, 4, 6 or 8 digits`);
      err.code = 400;
      throw err;
    }
    if (rate != null && !(rate >= 0 && rate <= 40)) {
      const err = new Error(`GST rate ${o.gstRate} for ${name} is out of range`);
      err.code = 400;
      throw err;
    }
    if (uqc && !/^[A-Z]{2,3}$/.test(uqc)) {
      const err = new Error(`UQC "${o.uqc}" for ${name} must be a GST unit code like NOS or KGS`);
      err.code = 400;
      throw err;
    }
    const { rows } = await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.gst_item_hsn_overrides (company_id, item_name, item_key, hsn_code, gst_rate, uqc, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (company_id, item_key) DO UPDATE SET
        item_name = EXCLUDED.item_name, hsn_code = EXCLUDED.hsn_code, gst_rate = EXCLUDED.gst_rate,
        uqc = EXCLUDED.uqc, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING item_name, hsn_code, gst_rate, uqc
      `,
      [companyId, name, normName(name), hsn, rate, uqc, updatedBy || null]
    );
    saved.push(rows[0]);
  }
  return saved;
}
