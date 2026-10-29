import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { resolveUserId } from "../utils/resolveUserId.js";
import { assertCompanyRefs } from "../middleware/companyAccess.middleware.js";
import { stockJournalQueue } from "../queues/stockJournal.queue.js";

const router = express.Router();

const normalizeName = (value) =>
  String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const validQuantity = (value) =>
  Number.isFinite(value) &&
  value > 0 &&
  Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8;

const validRate = (value) =>
  Number.isFinite(value) &&
  value >= 0 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;

router.post("/push/stock-journal", async (req, res) => {
  const {
    company_id,
    company,
    voucher_date,
    voucher_number,
    narration,
    entries,
  } = req.body ?? {};

  try {
    // 1. Authenticate user
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "No profile found for this account",
      });
    }

    // 2. Validate company
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

    const hasCompanyAccess = await assertCompanyRefs(req, res, {
      ids: [companyId],
      names: [company],
    });

    if (!hasCompanyAccess) return;

    const companyResult = await pool.query(
      `SELECT name, financial_year_start, financial_year_end
       FROM ${DB_SCHEMA}.companies
       WHERE id = $1
       LIMIT 1`,
      [companyId]
    );

    const companyRecord = companyResult.rows[0];

    if (!companyRecord) {
      return res.status(404).json({
        success: false,
        message: `Company not found: ${companyId}`,
      });
    }

    // 3. Validate voucher date
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

    // Indian financial year: 1 April to 31 March
    const startYear = Number(companyRecord.financial_year_start);
    const endYear = Number(companyRecord.financial_year_end);

    if (
      !Number.isInteger(startYear) ||
      !Number.isInteger(endYear) ||
      startYear < 1900 ||
      endYear !== startYear + 1
    ) {
      return res.status(500).json({
        success: false,
        message: "Company financial year is missing or invalid",
      });
    }

    const periodStart = `${startYear}-04-01`;
    const periodEnd = `${endYear}-03-31`;

    if (voucher_date < periodStart || voucher_date > periodEnd) {
      return res.status(400).json({
        success: false,
        message: "Voucher date is outside the company's accounting period",
        voucher_date,
        allowed_period: {
          start: periodStart,
          end: periodEnd,
        },
      });
    }

    // 4. Validate entries
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one stock entry is required",
      });
    }

    const cleanEntries = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return res.status(400).json({
          success: false,
          message: `Entry ${i}: must be a valid object`,
        });
      }

      const stockItemName = String(
        entry.stock_item_name ?? ""
      ).trim();

      const fromGodown = String(
        entry.from_godown ?? ""
      ).trim();

      const toGodown = String(
        entry.to_godown ?? ""
      ).trim();

      const fromQuantity = Number(entry.from_quantity);
      const toQuantity = Number(entry.to_quantity);
      const fromRate = Number(entry.from_rate);
      const toRate = Number(entry.to_rate);

      const missingFields = [];

      if (!stockItemName) missingFields.push("stock_item_name");
      if (!fromGodown) missingFields.push("from_godown");
      if (!toGodown) missingFields.push("to_godown");

      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Entry ${i}: required fields are missing`,
          missing_fields: missingFields,
        });
      }

      if (normalizeName(fromGodown) === normalizeName(toGodown)) {
        return res.status(400).json({
          success: false,
          message: `Entry ${i}: source and destination godowns must be different`,
        });
      }

      if (
        !validQuantity(fromQuantity) ||
        !validQuantity(toQuantity)
      ) {
        return res.status(400).json({
          success: false,
          message: `Entry ${i}: quantities must be positive with at most 3 decimal places`,
        });
      }

      if (!validRate(fromRate) || !validRate(toRate)) {
        return res.status(400).json({
          success: false,
          message: `Entry ${i}: rates must be non-negative with at most 2 decimal places`,
        });
      }

      cleanEntries.push({
        stock_item_name: stockItemName,
        from_godown: fromGodown,
        to_godown: toGodown,
        from_quantity: fromQuantity,
        from_rate: fromRate,
        to_quantity: toQuantity,
        to_rate: toRate,
      });
    }

    // 5. Fetch stock items and godowns for this company
    const [stockItemsResult, godownsResult] = await Promise.all([
      pool.query(
        `SELECT item_name, unit
         FROM ${DB_SCHEMA}.stock_group_summary
         WHERE company_id = $1`,
        [companyId]
      ),

      pool.query(
        `SELECT godown_name
         FROM ${DB_SCHEMA}.godown_details
         WHERE company_id = $1`,
        [companyId]
      ),
    ]);

    // IMPORTANT:
    // stock_group_summary uses item_name, NOT name.
    // Example: item_name = "Hard Disk", unit = "Pcs".
    const stockItemMap = new Map();

    for (const row of stockItemsResult.rows) {
      const key = normalizeName(row.item_name);

      if (key && !stockItemMap.has(key)) {
        stockItemMap.set(key, {
          name: row.item_name,
          unit: String(row.unit ?? "").trim(),
        });
      }
    }

    const godownSet = new Set(
      godownsResult.rows.map((row) =>
        normalizeName(row.godown_name)
      )
    );

    // 6. Validate stock item and godown names
    const masterErrors = [];

    for (let i = 0; i < cleanEntries.length; i += 1) {
      const entry = cleanEntries[i];

      if (!stockItemMap.has(normalizeName(entry.stock_item_name))) {
        masterErrors.push({
          entry_index: i,
          field: "stock_item_name",
          value: entry.stock_item_name,
          message: `Stock item '${entry.stock_item_name}' was not found for this company.`,
        });
      }

      if (!godownSet.has(normalizeName(entry.from_godown))) {
        masterErrors.push({
          entry_index: i,
          field: "from_godown",
          value: entry.from_godown,
          message: `Source godown '${entry.from_godown}' was not found for this company.`,
        });
      }

      if (!godownSet.has(normalizeName(entry.to_godown))) {
        masterErrors.push({
          entry_index: i,
          field: "to_godown",
          value: entry.to_godown,
          message: `Destination godown '${entry.to_godown}' was not found for this company.`,
        });
      }
    }

    if (masterErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Stock Journal master validation failed. No voucher was created.",
        errors: masterErrors,
      });
    }

    // 7. Automatically retrieve the stock item's unit
    for (const entry of cleanEntries) {
      const masterItem = stockItemMap.get(
        normalizeName(entry.stock_item_name)
      );

      if (!masterItem?.unit) {
        return res.status(400).json({
          success: false,
          message: `Unit is missing for stock item '${entry.stock_item_name}'.`,
        });
      }

      // Use the same master unit for both source and destination.
      entry.unit = masterItem.unit;
      entry.from_unit = masterItem.unit;
      entry.to_unit = masterItem.unit;
    }

    // 8. Save header and entries in a database transaction
    const client = await pool.connect();
    let stockJournalId;

    try {
      await client.query("BEGIN");

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
          companyRecord.name,
          voucher_date,
          voucher_number || null,
          narration || null,
          userId,
        ]
      );

      stockJournalId = header.rows[0].id;

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
             $8, $9, $10, $11, $12, $13, NOW(), NOW()
           )`,
          [
            stockJournalId,       // $1
            entry.stock_item_name, // $2
            entry.from_quantity,   // $3: legacy quantity
            entry.unit,            // $4: legacy unit
            entry.from_godown,     // $5
            entry.to_godown,       // $6
            entry.from_rate,       // $7: legacy rate
            entry.from_unit,       // $8
            entry.from_quantity,   // $9
            entry.from_rate,       // $10
            entry.to_unit,         // $11
            entry.to_quantity,     // $12
            entry.to_rate,         // $13
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

    // 9. Queue the voucher after the database transaction commits
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
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
});

export default router;