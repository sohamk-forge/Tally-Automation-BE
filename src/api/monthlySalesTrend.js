import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

async function getCompanyInfo(companyId, companyName) {
  let result;

  if (companyName) {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM app_test.companies
       WHERE LOWER(name) = LOWER($1)`,
      [companyName]
    );
  } else {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM app_test.companies
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
  const endYear = startYear + 1;

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
    `SELECT id, voucher_date, voucher_type, voucher_number,
            party_ledger_name, ledger_entries, debit_amount, credit_amount
       FROM app_test.vouchers
      WHERE company_id = $1
        AND DATE(voucher_date) >= $2
        AND DATE(voucher_date) < $3`,
    [companyId, yearStart, yearEnd]
  );

  console.log(`📊 Monthly Sales: ${result.rows.length} vouchers fetched`);
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

function isRealSalesVoucher(voucherTypeRaw) {
  const type = (voucherTypeRaw || "").toString().toLowerCase();
  if (!type.includes("sales")) return false;
  if (type.includes("return")) return false;
  if (type.includes("credit note")) return false;
  if (type.includes("debit note")) return false;
  return true;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function getMonthlySalesTrend(vouchers, yearStart, yearEnd) {
  const buckets = {};

  let current = new Date(yearStart);
  const end = new Date(yearEnd);
  while (current < end) {
    const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-01`;
    buckets[key] = {
      period_start: key,
      month_label: `${MONTH_NAMES[current.getMonth()]} ${current.getFullYear()}`,
      sales_total: 0
    };
    current.setMonth(current.getMonth() + 1);
  }

  for (const v of vouchers) {
    const d = new Date(v.voucher_date);
    if (isNaN(d.getTime())) continue;
    if (d >= end) continue;

    if (!isRealSalesVoucher(v.voucher_type)) continue;

    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

    if (!buckets[key]) {
      buckets[key] = {
        period_start: key,
        month_label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
        sales_total: 0
      };
    }

    buckets[key].sales_total += getVoucherAmount(v);
  }

  return Object.values(buckets)
    .map((b) => ({
      ...b,
      sales_total: Math.round(b.sales_total * 100) / 100
    }))
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
}

router.get("/monthly-sales-trend", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    const companyName = req.query.company?.trim();

    if (!companyId && !companyName) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id or company query parameter is required"
      });
    }

    const companyInfo = await getCompanyInfo(companyId, companyName);

    if (!companyInfo) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyInfo.id);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    const { id, name: company, yearStart, yearEnd, fyLabel } = companyInfo;

    const vouchers = await fetchVouchersFromDB(id, yearStart, yearEnd);
    const trend = getMonthlySalesTrend(vouchers, yearStart, yearEnd);

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: id,
      company,
      financial_year: fyLabel,
      voucher_count: vouchers.length,
      data: trend
    });

  } catch (err) {
    console.error("❌ MONTHLY SALES TREND ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;