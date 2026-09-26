import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { resolveOwnedCompanyByName } from "../middleware/companyAccess.middleware.js";
const router = express.Router();

async function getCompanyInfo(companyId, companyName) {
  let result;

  if (companyName) {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM ${DB_SCHEMA}.companies
       WHERE LOWER(name) = LOWER($1)
       ORDER BY (SELECT COUNT(*) FROM ${DB_SCHEMA}.vouchers v WHERE v.company_id = companies.id) DESC, id DESC
       LIMIT 1`,
      [companyName]
    );
  } else {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM ${DB_SCHEMA}.companies
       WHERE id = $1`,
      [companyId]
    );
  }

  const row = result.rows[0];
  if (!row) return null;

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

async function fetchVouchersFromDB(companyId, yearStart, yearEnd) {
  const result = await pool.query(
    // ledger_entries is a large JSON blob per voucher (MBs over the network),
    // and getVoucherAmount only needs it when both debit and credit are 0 —
    // so only fetch it for those rows, and only for sales/purchase vouchers.
    `SELECT voucher_date, voucher_type, debit_amount, credit_amount,
            CASE WHEN COALESCE(debit_amount, 0) = 0 AND COALESCE(credit_amount, 0) = 0
                 THEN ledger_entries END AS ledger_entries
       FROM ${DB_SCHEMA}.vouchers
      WHERE company_id = $1
        AND DATE(voucher_date) >= $2
        AND DATE(voucher_date) < $3
        AND deleted_at IS NULL`,
    [companyId, yearStart, yearEnd]
  );
  return result.rows;
}

function getVoucherAmount(v) {
  const debit = Math.abs(Number(v.debit_amount) || 0);
  if (debit > 0) return debit;

  const credit = Math.abs(Number(v.credit_amount) || 0);
  if (credit > 0) return credit;

  const entries = Array.isArray(v.ledger_entries) ? v.ledger_entries : [];
  let amount = 0;
  for (const e of entries) {
    amount += Math.abs(parseFloat(e?.AMOUNT) || 0);
  }
  return amount / 2;
}

function getBucketKey(dateObj, period) {
  const d = dateObj;

  if (period === "day") return d.toISOString().split("T")[0];

  if (period === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }

  if (period === "year") {
    return `${d.getFullYear()}-01-01`;
  }

  if (period === "week") {
    const day = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - day + 1);
    return monday.toISOString().split("T")[0];
  }

  return d.toISOString().split("T")[0];
}

function bucketVouchers(vouchers, period) {
  const buckets = {};

  for (const v of vouchers) {
    const d = new Date(v.voucher_date);
    if (isNaN(d.getTime())) continue;

    const voucherType = (v.voucher_type || "").toString().toLowerCase();
    const isSales = voucherType.includes("sales");
    const isPurchase = voucherType.includes("purchase");
    if (!isSales && !isPurchase) continue;

    const amount = getVoucherAmount(v);
    const key = getBucketKey(d, period);

    if (!buckets[key]) {
      buckets[key] = { period_start: key, sales_total: 0, purchase_total: 0 };
    }

    if (isSales) buckets[key].sales_total += amount;
    if (isPurchase) buckets[key].purchase_total += amount;
  }

  return Object.values(buckets)
    .map((b) => ({ ...b, net: b.sales_total - b.purchase_total }))
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
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
    const companyInfo = ownedCompanyId ? await getCompanyInfo(ownedCompanyId, null) : null;

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