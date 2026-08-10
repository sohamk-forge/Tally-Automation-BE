/* ===================================================
   PROFIT & LOSS SUMMARY — ROUTES
   GET /profit-loss-summary-sync?company=...
   GET /profit-loss-summary-sync?company=...&fromDate=...&toDate=...

   CHANGED: fromDate / toDate are now OPTIONAL.
   If you don't pass them, the service defaults to the
   current financial year (1-Apr through today) —
   no more date-format guessing on the caller's end.
=================================================== */

import express from "express";
import pool from "../db/index.js";
import { syncProfitLossSummary } from "../services/profitLossSummarySync.service.js";

const router = express.Router();

async function getCompanyId(company, client) {
  const result = await client.query(
    `SELECT id FROM app_test.companies WHERE name = $1`,
    [company]
  );
  return result.rows[0]?.id || null;
}
/* ===================================================
  PROFIT & LOSS SUMMARY SYNC
  GET /api/sync/profit-loss-summary-sync?company=...
  GET /api/sync/profit-loss-summary-sync?company=...&fromDate=2024-04-01&toDate=2025-03-31

  fromDate/toDate are OPTIONAL — defaults to current
  financial year (1 Apr → today) if omitted.
  Accepts either "YYYY-MM-DD" or Tally's "YYYYMMDD".
=================================================== */

router.get("/profit-loss-summary-sync", async (req, res) => {
  const company = req.query.company;
  const fromDate = req.query.fromDate || null;
  const toDate = req.query.toDate || null;

  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const companyId = await getCompanyId(company, client);
    if (!companyId) throw new Error("Company not found");

    const summary = await syncProfitLossSummary(client, {
      company,
      companyId,
      fromDate,
      toDate,
      userId: req.headers["x-user-id"] || null
    });

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Profit & loss summary synced successfully",
      company,
      data: summary
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ PROFIT LOSS SUMMARY SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
  PROFIT MARGIN (READ-ONLY, AUTO-SYNCS IF MISSING)
  GET /api/sync/profit-margin?company_id=...
  GET /api/sync/profit-margin?company_id=...&fromDate=2024-04-01&toDate=2025-03-31
=================================================== */
router.get("/profit-margin", async (req, res) => {
  const companyId = Number(req.query.company_id);
  const fromDate = req.query.fromDate || null;
  const toDate = req.query.toDate || null;

  if (!companyId) {
    return res.status(400).json({
      status: "error",
      message: "company_id query parameter required"
    });
  }

  const client = await pool.connect();

  try {
    // Fetch company name (needed only if we need to sync)
    const companyResult = await client.query(
      `
      SELECT name AS company_name
      FROM app_test.companies
      WHERE id = $1
      `,
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      throw new Error("Company not found");
    }

    const company = companyResult.rows[0].company_name;

    // Try reading existing summary
    let query;
    let params;

    if (fromDate && toDate) {
      query = `
        SELECT *
        FROM app_test.profit_loss_summary
        WHERE company_id = $1
          AND from_date = $2
          AND to_date = $3
      `;
      params = [companyId, fromDate, toDate];
    } else {
      query = `
        SELECT *
        FROM app_test.profit_loss_summary
        WHERE company_id = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      params = [companyId];
    }

    let existing = await client.query(query, params);

    // If summary doesn't exist, sync it from Tally
    if (existing.rows.length === 0 || (fromDate && toDate)) {
      await client.query("BEGIN");

      await syncProfitLossSummary(client, {
        company,
        companyId,
        fromDate,
        toDate,
        userId: req.headers["x-user-id"] || null
      });

      await client.query("COMMIT");

      existing = await client.query(query, params);
    }

    const row = existing.rows[0];

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      fromDate: row.from_date,
      toDate: row.to_date,
      totalSales: Number(row.total_sales),
      grossProfit: Number(row.gross_profit),
      grossProfitPercent: Number(row.gross_profit_percent),
      netResult: Number(row.net_result),
      resultType: row.result_type,
      profitMarginPercent: Number(row.profit_margin_percent),
      lastSyncedAt: row.updated_at
    });

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.log("❌ PROFIT MARGIN ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});
export default router;