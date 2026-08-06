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

router.get("/profit-loss-summary-sync", async (req, res) => {
  const company = req.query.company;

  // fromDate / toDate are now OPTIONAL — only company is required
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
      fromDate: summary.fromDate,   // the ACTUAL period used (auto-filled if you didn't pass one)
      toDate: summary.toDate,
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

export default router;