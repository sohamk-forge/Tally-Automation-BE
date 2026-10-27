
import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { resolveUserId } from "../utils/resolveUserId.js";
import { assertCompanyRefs } from "../middleware/companyAccess.middleware.js";
import { stockJournalQueue } from "../queues/stockJournal.queue.js";

const router = express.Router();

router.post("/push/stock-journal", async (req, res) => {
  const {
    company_id,
    company,
    voucher_date,
    voucher_number,
    narration,
    entries
  } = req.body;

  try {
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "No profile found for this account"
      });
    }

    const companyId = Number(company_id);

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid company_id is required"
      });
    }

    if (typeof company !== "string" || !company.trim()) {
      return res.status(400).json({
        success: false,
        message: "company is required"
      });
    }

    if (!(await assertCompanyRefs(req, res, {
      ids: [companyId],
      names: [company]
    }))) {
      return;
    }

    if (
      typeof voucher_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(voucher_date) ||
      Number.isNaN(Date.parse(voucher_date)) ||
      new Date(`${voucher_date}T00:00:00Z`)
        .toISOString().slice(0, 10) !== voucher_date
    ) {
      return res.status(400).json({
        success: false,
        message: "voucher_date must be a valid YYYY-MM-DD date"
      });
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one stock entry is required"
      });
    }

    const cleanEntries = [];

    for (const entry of entries) {
      const stockItemName = String(
        entry?.stock_item_name ?? ""
      ).trim();

      const fromGodown = String(
        entry?.from_godown ?? ""
      ).trim();

      const toGodown = String(
        entry?.to_godown ?? ""
      ).trim();

      const unit = String(entry?.unit ?? "").trim();
      const quantity = Number(entry?.quantity);
      const rate = Number(entry?.rate);

      if (!stockItemName || !fromGodown || !toGodown || !unit) {
        return res.status(400).json({
          success: false,
          message: "Stock item, unit, source and destination godown are required"
        });
      }

      if (fromGodown.toLowerCase() === toGodown.toLowerCase()) {
        return res.status(400).json({
          success: false,
          message: "Source and destination godowns must be different"
        });
      }

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-8
      ) {
        return res.status(400).json({
          success: false,
          message: "Quantity must be positive with at most 3 decimal places"
        });
      }

      if (
        !Number.isFinite(rate) ||
        rate < 0 ||
        Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-8
      ) {
        return res.status(400).json({
          success: false,
          message: "Rate must be non-negative with at most 2 decimal places"
        });
      }

      cleanEntries.push({
        stock_item_name: stockItemName,
        from_godown: fromGodown,
        to_godown: toGodown,
        unit,
        quantity,
        rate
      });
    }

    const companyResult = await pool.query(
      `SELECT name
       FROM ${DB_SCHEMA}.companies
       WHERE id = $1
       LIMIT 1`,
      [companyId]
    );

    const companyName = companyResult.rows[0]?.name;

    if (!companyName) {
      return res.status(404).json({
        success: false,
        message: "Company not found"
      });
    }

    const client = await pool.connect();
    let stockJournalId;

    try {
      await client.query("BEGIN");

      const header = await client.query(
        `INSERT INTO ${DB_SCHEMA}.push_stock_journals
         (company_id, company_name, voucher_date,
          voucher_number, voucher_type, narration,
          status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Stock Journal',
                 $5, 'pending', $6, NOW(), NOW())
         RETURNING id`,
        [
          companyId,
          companyName,
          voucher_date,
          voucher_number || null,
          narration || null,
          userId
        ]
      );

      stockJournalId = header.rows[0].id;

      for (const entry of cleanEntries) {
        await client.query(
          `INSERT INTO ${DB_SCHEMA}.push_stock_journal_entries
           (stock_journal_id, stock_item_name, quantity,
            unit, from_godown, to_godown, rate,
            created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [
            stockJournalId,
            entry.stock_item_name,
            entry.quantity,
            entry.unit,
            entry.from_godown,
            entry.to_godown,
            entry.rate
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    try {
      const job = await stockJournalQueue.add(
        "push-stock-journal",
        { stockJournalId, userId },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );

      return res.status(202).json({
        success: true,
        message: "Stock Journal queued successfully",
        stockJournalId,
        jobId: job.id,
        status: "pending"
      });
    } catch (error) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.push_stock_journals
         SET status = 'failed',
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [`Could not queue Stock Journal: ${error.message}`, stockJournalId]
      );

      return res.status(503).json({
        success: false,
        message: "Could not queue Stock Journal",
        stockJournalId
      });
    }
  } catch (error) {
    console.error("Stock Journal API error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create Stock Journal"
    });
  }
});

export default router;
