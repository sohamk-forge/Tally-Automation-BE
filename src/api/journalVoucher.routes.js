import express from "express";

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

import { journalVoucherQueue } from "../queues/journalVoucher.queue.js";

import { resolveUserId } from "../utils/resolveUserId.js";

import { assertCompanyRefs } from "../middleware/companyAccess.middleware.js";

const router = express.Router();

const ALLOWED_VOUCHER_TYPES = ["Journal"];

const badRequest = (res, message, extra = {}) =>
  res.status(400).json({ success: false, message, ...extra });

// Auth: mounted behind requireSessionAndCompany() in app.js, which has
// already authenticated the caller and checked that company_id belongs to
// them. resolveUserId() maps whichever auth method was used to the LOCAL
// numeric users.id — req.session.getUserId() alone is the SuperTokens UUID,
// which created_by (integer) and the connector lookups can't use.
router.post("/push/journal-voucher", async (req, res) => {
  try {
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "No profile found for this account"
      });
    }

    const {
      company_id,
      company,
      voucher_date,
      voucher_number,
      voucher_type = "Journal",
      narration,
      entries
    } = req.body;

    // -----------------------------
    // BASIC VALIDATION
    // -----------------------------

    const companyId = Number(company_id);

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return badRequest(res, "A valid company_id is required");
    }

    // Same contract as the other push routes: both company_id and company
    // are mandatory.
    if (typeof company !== "string" || !company.trim()) {
      return badRequest(res, "company is required");
    }

    // Belt and braces next to the app-level guard: ownership of company_id,
    // and that company names the SAME company as company_id.
    if (
      !(await assertCompanyRefs(req, res, {
        ids: [companyId],
        names: [company]
      }))
    ) {
      return;
    }

    if (
      typeof voucher_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(voucher_date) ||
      Number.isNaN(Date.parse(voucher_date)) ||
      new Date(voucher_date).toISOString().slice(0, 10) !== voucher_date
    ) {
      return badRequest(res, "voucher_date must be a valid date (YYYY-MM-DD)");
    }

    if (!ALLOWED_VOUCHER_TYPES.includes(voucher_type)) {
      return badRequest(
        res,
        `voucher_type must be one of: ${ALLOWED_VOUCHER_TYPES.join(", ")}`
      );
    }

    if (!Array.isArray(entries)) {
      return badRequest(res, "entries must be an array");
    }

    if (entries.length < 2) {
      return badRequest(res, "Journal voucher needs at least two entries");
    }

    // -----------------------------
    // VALIDATE ENTRIES
    // -----------------------------

    let totalDebit = 0;
    let totalCredit = 0;
    const cleanEntries = [];

    for (const entry of entries) {
      const ledgerName = String(entry?.ledger_name ?? "").trim();

      if (!ledgerName) {
        return badRequest(res, "ledger_name is required");
      }

      const amount = Number(entry.amount);

      // Number.isFinite also rejects NaN ("abc") and Infinity, which
      // sail through a plain `<= 0` check.
      if (!Number.isFinite(amount) || amount <= 0) {
        return badRequest(res, "amount must be a number greater than zero");
      }

      const type = String(entry.type || entry.entry_type || "").toLowerCase();

      if (!["debit", "credit"].includes(type)) {
        return badRequest(res, "type must be debit or credit");
      }

      if (type === "debit") {
        totalDebit += amount;
      } else {
        totalCredit += amount;
      }

      cleanEntries.push({
        ledgerName,
        amount,
        type,
        description: entry.description || null
      });
    }

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return badRequest(res, "Debit and Credit must be equal", {
        totalDebit,
        totalCredit
      });
    }

    // -----------------------------
    // COMPANY NAME FROM DB, NOT THE CLIENT
    // -----------------------------

    // The name goes straight into <SVCURRENTCOMPANY>; trusting the request
    // body for it would let the stored id and the Tally company disagree.
    const companyResult = await pool.query(
      `SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );

    const companyName = companyResult.rows[0]?.name;

    if (!companyName) {
      return res.status(404).json({
        success: false,
        message: `Company not found: ${companyId}`
      });
    }

    // -----------------------------
    // INSERT VOUCHER + ENTRIES (ONE TRANSACTION)
    // -----------------------------

    const client = await pool.connect();
    let voucherId;

    try {
      await client.query("BEGIN");

      const voucherResult = await client.query(
        `
        INSERT INTO ${DB_SCHEMA}.push_journal_vouchers
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
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), NOW())
        RETURNING id
        `,
        [
          companyId,
          companyName,
          voucher_date,
          voucher_number || null,
          voucher_type,
          narration || null,
          userId
        ]
      );

      voucherId = voucherResult.rows[0].id;

      for (const entry of cleanEntries) {
        await client.query(
          `
          INSERT INTO ${DB_SCHEMA}.push_journal_voucher_entries
          (
            voucher_id,
            ledger_name,
            amount,
            entry_type,
            description,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          `,
          [
            voucherId,
            entry.ledgerName,
            entry.amount,
            entry.type,
            entry.description
          ]
        );
      }

      await client.query("COMMIT");
    } catch (insertError) {
      await client.query("ROLLBACK").catch(() => {});
      throw insertError;
    } finally {
      client.release();
    }

    // -----------------------------
    // ADD BULLMQ JOB
    // -----------------------------

    let job;

    try {
      job = await journalVoucherQueue.add(
        "push-journal-voucher",
        { voucherId, userId },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );
    } catch (queueError) {
      // The rows are committed but nothing will ever process them — say so
      // instead of leaving a voucher 'pending' forever.
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_journal_vouchers
        SET status = 'failed', error_message = $1, updated_at = NOW()
        WHERE id = $2
        `,
        [`Could not queue voucher: ${queueError.message}`, voucherId]
      );

      console.error("Journal voucher enqueue error:", queueError);

      return res.status(503).json({
        success: false,
        message: "Could not queue the journal voucher. Please retry.",
        voucherId
      });
    }

    return res.status(202).json({
      success: true,
      message: "Journal voucher queued successfully",
      voucherId,
      jobId: job.id,
      status: "pending",
      totalDebit,
      totalCredit
    });
  } catch (error) {
    console.error("Journal voucher API error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create journal voucher"
    });
  }
});

export default router;
