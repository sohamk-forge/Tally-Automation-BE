import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { resolveOwnedCompanyByName } from "../middleware/companyAccess.middleware.js";
import { bucketVouchers } from "../services/trendBuckets.js";
const router = express.Router();

// Id-only: names aren't unique, so callers resolve a name to the caller's own
// company id (resolveOwnedCompanyByName) before getting here.
// fyStart (optional, 4-digit year): the financial year the dashboard has picked, instead of the company's stored years.
async function getCompanyInfo(companyId, fyStart) {
  const result = await pool.query(
    `SELECT id, name, financial_year_start, financial_year_end
     FROM ${DB_SCHEMA}.companies
     WHERE id = $1`,
    [companyId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const pickedYear = Number(fyStart);
  if (Number.isInteger(pickedYear) && pickedYear >= 2000 && pickedYear <= 2100) {
    return {
      id: row.id,
      name: row.name,
      yearStart: `${pickedYear}-04-01`,
      yearEnd: `${pickedYear + 1}-04-01`,
      fyLabel: `${pickedYear}-${pickedYear + 1}`
    };
  }

  if (!row.financial_year_start) {
    const now = new Date();
    const y = now.getFullYear();
    return {
      id: row.id,
      name: row.name,
      yearStart: `${y}-04-01`,
      yearEnd: `${y + 1}-04-01`,
      fyLabel: `${y}-${y + 1}`
    };
  }

  const startYear = Number(row.financial_year_start);
  // Some company books span more than one FY (e.g. start 2025, end 2027);
  // never end earlier than start + 1.
  const storedEnd = Number(row.financial_year_end);
  const endYear = Number.isFinite(storedEnd) && storedEnd > startYear + 1 ? storedEnd : startYear + 1;

  return {
    id: row.id,
    name: row.name,
    yearStart: `${startYear}-04-01`,
    yearEnd: `${endYear}-04-01`,
    fyLabel: `${startYear}-${endYear}`
  };
}

// One row per voucher with what it posted to Sales Accounts / Purchase Accounts (ex-GST, credit and
// debit notes netted) — the P&L basis, so the chart adds up to the Total sales / Total purchase tiles.
// Whole-voucher totals were used before: they include GST and counted quotations as sales.
// Non-accounting documents (quotations, orders, delivery / receipt notes) are left out, as Tally does.
async function fetchVouchersFromDB(companyId, yearStart, yearEnd) {
  const result = await pool.query(
    `SELECT v.voucher_date,
            COALESCE(SUM(CASE WHEN l.primary_group = 'Sales Accounts'
                              THEN (e->>'AMOUNT')::numeric END), 0) AS sales_amount,
            COALESCE(SUM(CASE WHEN l.primary_group = 'Purchase Accounts'
                              THEN -(e->>'AMOUNT')::numeric END), 0) AS purchase_amount
       FROM ${DB_SCHEMA}.vouchers v
       CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(v.ledger_entries) = 'array' THEN v.ledger_entries ELSE '[]'::jsonb END) e
       JOIN ${DB_SCHEMA}.all_ledger_details l
         ON l.company_id = v.company_id AND l.ledger_name = e->>'LEDGERNAME' AND l.deleted_at IS NULL
      WHERE v.company_id = $1
        AND v.deleted_at IS NULL
        AND v.is_optional IS NOT TRUE
        AND DATE(v.voucher_date) >= $2
        AND DATE(v.voucher_date) < $3
        AND l.primary_group IN ('Sales Accounts', 'Purchase Accounts')
        AND LOWER(v.voucher_type) !~ '(quotation|order|delivery|receipt note|rejection|memorandum)'
      GROUP BY v.id, v.voucher_date`,
    [companyId, yearStart, yearEnd]
  );
  return result.rows;
}

router.get("/sales-purchase", async (req, res) => {
  try {
    const companyId = req.query.company_id;
    const companyName = req.query.company;

    if (!companyId && !companyName) {
      return res.status(400).json({
        status: "error",
        message: "company_id or company query parameter is required"
      });
    }

    // A name is resolved among the caller's own companies only — the old
    // global name lookup could pick another tenant's same-named company.
    const ownedCompanyId = companyId || (await resolveOwnedCompanyByName(req, companyName));
    const companyInfo = ownedCompanyId ? await getCompanyInfo(ownedCompanyId, req.query.fy_start) : null;

    if (!companyInfo) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    const { id, name: company, yearStart, yearEnd, fyLabel } = companyInfo;

    const vouchers = await fetchVouchersFromDB(id, yearStart, yearEnd);

    const stripNet = (arr) =>
      arr.map(({ period_start, sales_total, purchase_total }) => ({
        period_start,
        sales_total,
        purchase_total
      }));

    const day = stripNet(bucketVouchers(vouchers, "day"));
    const week = stripNet(bucketVouchers(vouchers, "week"));
    const month = stripNet(bucketVouchers(vouchers, "month"));
    const year = bucketVouchers(vouchers, "year");

    const todayStr = new Date().toISOString().split("T")[0];
    const rawToday = day.find((d) => d.period_start === todayStr);
    const today = rawToday || { period_start: todayStr, sales_total: 0, purchase_total: 0 };

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: id,
      company,
      financial_year: fyLabel,
      financial_year_start: yearStart,
      financial_year_end: yearEnd,
      voucher_count: vouchers.length,
      data: { today, day, week, month, year }
    });

  } catch (err) {
    console.error("❌ SALES-PURCHASE TREND ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;