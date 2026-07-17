import express from "express";
import pool from "../db/index.js";

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

/* ===================================================
   TOP SALES LEDGERS — using party_ledger_name + debit_amount
=================================================== */
async function getTopSellingItems(companyId, yearStart, yearEnd) {
  const result = await pool.query(
    `SELECT ledger_entries
     FROM app_test.vouchers
     WHERE company_id = $1
       AND DATE(voucher_date) >= $2
       AND DATE(voucher_date) < $3
       AND LOWER(voucher_type) LIKE '%sales%'
       AND LOWER(voucher_type) NOT LIKE '%return%'
       AND LOWER(voucher_type) NOT LIKE '%credit note%'
       AND LOWER(voucher_type) NOT LIKE '%debit note%'`,
    [companyId, yearStart, yearEnd]
  );

  const itemMap = new Map();

  for (const row of result.rows) {
    const entries = row.ledger_entries || [];

    for (const entry of entries) {
      const inventory = entry["INVENTORYALLOCATIONS.LIST"];

      if (!inventory) continue;

      const itemName = inventory.STOCKITEMNAME;
      const amount = Math.abs(Number(inventory.AMOUNT) || 0);

      if (!itemName) continue;

      if (!itemMap.has(itemName)) {
        itemMap.set(itemName, {
          item_name: itemName,
          total_sales: 0,
          voucher_count: 0
        });
      }

      const item = itemMap.get(itemName);
      item.total_sales += amount;
      item.voucher_count++;
    }
  }

  const allItems = [...itemMap.values()].sort(
    (a, b) => b.total_sales - a.total_sales
  );

  const grandTotal = allItems.reduce(
    (sum, item) => sum + item.total_sales,
    0
  );

  const topItems = allItems.slice(0, TOP_LEDGERS_LIMIT).map((item, index) => ({
    rank: index + 1,
    item_name: item.item_name,
    total_sales: Number(item.total_sales.toFixed(2)),
    voucher_count: item.voucher_count,
    percentage:
      grandTotal > 0
        ? Number(((item.total_sales / grandTotal) * 100).toFixed(2))
        : 0
  }));

  return {
    topItems,
    grandTotal: Number(grandTotal.toFixed(2)),
    totalVoucherCount: allItems.reduce(
      (sum, item) => sum + item.voucher_count,
      0
    )
  };
}

router.get("/top-sales-ledgers", async (req, res) => {
  try {
    const companyId = req.query.company_id;
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

    const { id, name: company, yearStart, yearEnd, fyLabel } = companyInfo;

    const { topItems, grandTotal, totalVoucherCount } =
       await getTopSellingItems(id, yearStart, yearEnd);

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
      top_items_count: topItems.length,
      data: topItems
    });

  } catch (err) {
    console.error("❌ TOP SALES ITEMS ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;