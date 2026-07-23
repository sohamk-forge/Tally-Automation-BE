import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

const TOP_LEDGERS_LIMIT = 3;

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

async function getTopSellingLedgers(companyId, yearStart, yearEnd) {
  const result = await pool.query(
    `SELECT party_ledger_name,
            SUM(ABS(debit_amount)) AS total_sales,
            COUNT(*) AS voucher_count
       FROM app_test.vouchers
      WHERE company_id = $1
        AND DATE(voucher_date) >= $2
        AND DATE(voucher_date) < $3
        AND LOWER(voucher_type) LIKE '%sales%'
        AND LOWER(voucher_type) NOT LIKE '%return%'
        AND LOWER(voucher_type) NOT LIKE '%credit note%'
        AND LOWER(voucher_type) NOT LIKE '%debit note%'
        AND party_ledger_name IS NOT NULL
        AND TRIM(party_ledger_name) != ''
      GROUP BY party_ledger_name
      ORDER BY total_sales DESC`,
    [companyId, yearStart, yearEnd]
  );

  const allLedgers = result.rows.map((r) => ({
    ledger_name: r.party_ledger_name,
    total_sales: Number(r.total_sales) || 0,
    voucher_count: Number(r.voucher_count)
  }));

  const grandTotal = allLedgers.reduce((sum, l) => sum + l.total_sales, 0);

  const topLedgers = allLedgers
    .slice(0, TOP_LEDGERS_LIMIT)
    .map((item, index) => ({
      rank: index + 1,
      ledger_name: item.ledger_name,
      total_sales: Math.round(item.total_sales * 100) / 100,
      voucher_count: item.voucher_count,
      percentage:
        grandTotal > 0
          ? Math.round((item.total_sales / grandTotal) * 10000) / 100
          : 0
    }));

  return {
    topLedgers,
    grandTotal: Math.round(grandTotal * 100) / 100,
    totalVoucherCount: allLedgers.reduce((sum, l) => sum + l.voucher_count, 0)
  };
}

router.get("/top-sales-ledgers", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    let companyId = validateCompanyId(req.query.company_id);
    const companyName = req.query.company;

    if (!companyId && !companyName) {
      return res.status(400).json({
        status: "error",
        message: "company_id or company query parameter is required"
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

    const { topLedgers, grandTotal, totalVoucherCount } =
      await getTopSellingLedgers(id, yearStart, yearEnd);

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: id,
      company,
      financial_year: fyLabel,
      financial_year_start: yearStart,
      financial_year_end: yearEnd,
      voucher_count: totalVoucherCount,
      grand_total_sales: grandTotal,
      top_ledgers_count: topLedgers.length,
      data: topLedgers
    });

  } catch (err) {
    console.error("❌ TOP SALES LEDGERS ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;