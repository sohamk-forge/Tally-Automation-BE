
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
    entries,
  } = req.body;

  try {
    // 1. Resolve authenticated user.
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "No profile found for this account",
      });
    }

    // 2. Validate company ID.
    const companyId = Number(company_id);

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid company_id is required",
      });
    }

    if (typeof company !== "string" || !company.trim()) {
      return res.status(400).json({
        success: false,
        message: "company is required",
      });
    }

    if (
      !(await assertCompanyRefs(req, res, {
        ids: [companyId],
        names: [company],
      }))
    ) {
      return;
    }

    // 3. Validate voucher date.
    if (
      typeof voucher_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(voucher_date) ||
      Number.isNaN(Date.parse(voucher_date)) ||
      new Date(voucher_date).toISOString().slice(0, 10) !== voucher_date
    ) {
      return res.status(400).json({
        success: false,
        message: "voucher_date must be a valid date (YYYY-MM-DD)",
      });
    }

    // 4. Fetch company details once.
    const companyResult = await pool.query(
      `SELECT name, financial_year_start, financial_year_end
       FROM ${DB_SCHEMA}.companies
       WHERE id = $1
       LIMIT 1`,
      [companyId]
    );

    const companyRecord = companyResult.rows[0];

    if (!companyRecord?.name) {
      return res.status(404).json({
        success: false,
        message: `Company not found: ${companyId}`,
      });
    }

    const companyName = companyRecord.name;

    // 5. Validate the company's financial year.
    const parseFinancialYear = (value) => {
      const year = String(value ?? "").trim();
      return /^\d{4}$/.test(year) ? Number(year) : null;
    };

    const startYear = parseFinancialYear(
      companyRecord.financial_year_start
    );

    const endYear = parseFinancialYear(
      companyRecord.financial_year_end
    );

    if (
      startYear === null ||
      endYear === null ||
      endYear !== startYear + 1
    ) {
      return res.status(500).json({
        success: false,
        message: "Company financial year is missing or invalid.",
      });
    }

    // Indian financial-year convention: 1 April to 31 March.
    const periodStart = `${startYear}-04-01`;
    const periodEnd = `${endYear}-03-31`;

    if (voucher_date < periodStart || voucher_date > periodEnd) {
      return res.status(400).json({
        success: false,
        message: "Voucher date is outside the company's accounting period.",
        voucher_date,
        allowed_period: {
          start: periodStart,
          end: periodEnd,
        },
      });
    }

    // 6. Validate the entries array.
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one stock entry is required",
      });
    }

    const cleanEntries = [];

    const validQuantity = (value) =>
      Number.isFinite(value) &&
      value > 0 &&
      Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8;

    const validRate = (value) =>
      Number.isFinite(value) &&
      value >= 0 &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;

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

      const fromUnit = String(
        entry?.from_unit ?? ""
      ).trim();

      const toUnit = String(
        entry?.to_unit ?? ""
      ).trim();

      const fromQuantity = Number(entry?.from_quantity);
      const toQuantity = Number(entry?.to_quantity);

      const fromRate = Number(entry?.from_rate);
      const toRate = Number(entry?.to_rate);

      if (
        !stockItemName ||
        !fromGodown ||
        !toGodown ||
        !fromUnit ||
        !toUnit
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Stock item, both godowns, and both units are required",
        });
      }

      if (fromGodown.toLowerCase() === toGodown.toLowerCase()) {
        return res.status(400).json({
          success: false,
          message:
            "Source and destination godowns must be different",
        });
      }

      if (
        !validQuantity(fromQuantity) ||
        !validQuantity(toQuantity)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Source and destination quantities must be positive with at most 3 decimal places",
        });
      }

      if (!validRate(fromRate) || !validRate(toRate)) {
        return res.status(400).json({
          success: false,
          message:
            "Source and destination rates must be non-negative with at most 2 decimal places",
        });
      }

      cleanEntries.push({
        stock_item_name: stockItemName,
        from_godown: fromGodown,
        from_unit: fromUnit,
        from_quantity: fromQuantity,
        from_rate: fromRate,
        to_godown: toGodown,
        to_unit: toUnit,
        to_quantity: toQuantity,
        to_rate: toRate,
      });
    }

    // 7. Initialize the client BEFORE any client.query() calls.
    const client = await pool.connect();
    let stockJournalId;

    try {
      await client.query("BEGIN");

      // 8. Insert Stock Journal header.
      const header = await client.query(
        `INSERT INTO ${DB_SCHEMA}.push_stock_journals
         (
           company_id,
           company_name,
           voucher_date,
           voucher_number,
           voucher_type,
           narration,
           status,
           created_by,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'Stock Journal',
                 $5, 'pending', $6, NOW(), NOW())
         RETURNING id`,
        [
          companyId,
          companyName,
          voucher_date,
          voucher_number || null,
          narration || null,
          userId,
        ]
      );

      stockJournalId = header.rows[0].id;

      // 9. Insert each entry with separate source and destination values.
      for (const entry of cleanEntries) {
        await client.query(
          `INSERT INTO ${DB_SCHEMA}.push_stock_journal_entries
           (
             stock_journal_id,
             stock_item_name,
             quantity,
             unit,
             from_godown,
             to_godown,
             rate,
             from_unit,
             from_quantity,
             from_rate,
             to_unit,
             to_quantity,
             to_rate,
             created_at,
             updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13,
             NOW(), NOW()
           )`,
          [
            stockJournalId,
            entry.stock_item_name,

            // Existing columns retained for compatibility.
            entry.from_quantity,
            entry.from_unit,
            entry.from_godown,
            entry.to_godown,
            entry.from_rate,

            // New source-side fields.
            entry.from_unit,
            entry.from_quantity,
            entry.from_rate,

            // New destination-side fields.
            entry.to_unit,
            entry.to_quantity,
            entry.to_rate,
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

    // 10. Queue the Stock Journal for Tally processing.
    try {
      const job = await stockJournalQueue.add(
        "push-stock-journal",
        { stockJournalId, userId },
        {
          attempts: 5,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
          removeOnComplete: 100,
          removeOnFail: 100,
        }
      );

      return res.status(202).json({
        success: true,
        message: "Stock Journal queued successfully",
        stockJournalId,
        jobId: job.id,
        status: "pending",
      });
    } catch (error) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.push_stock_journals
         SET status = 'failed',
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [
          `Could not queue Stock Journal: ${error.message}`,
          stockJournalId,
        ]
      );

      return res.status(503).json({
        success: false,
        message: "Could not queue Stock Journal",
        stockJournalId,
      });
    }
  } catch (error) {
    console.error("Stock Journal API error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create Stock Journal",
    });
  }
});

export default router;
