import express from "express";

import pool from "../db/index.js";

import {
  DB_SCHEMA
} from "../config/db.js";

import {
  journalVoucherQueue
} from "../queues/journalVoucher.queue.js";

import {
  verifySession
} from "supertokens-node/recipe/session/framework/express/index.js";

const router = express.Router();

router.post(
  "/push/journal-voucher",
  verifySession(),
  async (req, res) => {
    try {
      const userId =
        req.session.getUserId();
        // const userId =
        //   req.session?.getUserId?.() ||
        //    req.connectorMachine?.userId;

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

      if (!company_id) {
        return res.status(400).json({
          success: false,
          message: "company_id is required"
        });
      }

      if (!company) {
        return res.status(400).json({
          success: false,
          message: "company is required"
        });
      }

      if (!voucher_date) {
        return res.status(400).json({
          success: false,
          message:
            "voucher_date is required"
        });
      }

      if (!entries || !Array.isArray(entries)) {
        return res.status(400).json({
          success: false,
          message:
            "entries must be an array"
        });
      }

      if (entries.length < 2) {
        return res.status(400).json({
          success: false,
          message:
            "Journal voucher needs at least two entries"
        });
      }

      // -----------------------------
      // VALIDATE ENTRIES
      // -----------------------------

      let totalDebit = 0;
      let totalCredit = 0;

      for (const entry of entries) {
        if (!entry.ledger_name) {
          return res.status(400).json({
            success: false,
            message:
              "ledger_name is required"
          });
        }

        if (
          entry.amount === undefined ||
          Number(entry.amount) <= 0
        ) {
          return res.status(400).json({
            success: false,
            message:
              "amount must be greater than zero"
          });
        }

        const type =
          String(
            entry.type ||
              entry.entry_type ||
              ""
          ).toLowerCase();

        if (
          !["debit", "credit"].includes(type)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "type must be debit or credit"
          });
        }

        if (type === "debit") {
          totalDebit += Number(
            entry.amount
          );
        } else {
          totalCredit += Number(
            entry.amount
          );
        }
      }

      // -----------------------------
      // BALANCE CHECK
      // -----------------------------

      if (
        Math.abs(
          totalDebit - totalCredit
        ) > 0.01
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Debit and Credit must be equal",
          totalDebit,
          totalCredit
        });
      }

      // -----------------------------
      // INSERT VOUCHER
      // -----------------------------

      const voucherResult =
        await pool.query(
          `
          INSERT INTO
          ${DB_SCHEMA}.push_journal_vouchers
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
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'pending',
            $7,
            NOW(),
            NOW()
          )
          RETURNING id
          `,
          [
            company_id,
            company,
            voucher_date,
            voucher_number ||
              null,
            voucher_type,
            narration || null,
            userId
          ]
        );

      const voucherId =
        voucherResult.rows[0].id;

      // -----------------------------
      // INSERT ENTRIES
      // -----------------------------

      for (const entry of entries) {
        const type =
          String(
            entry.type ||
              entry.entry_type
          ).toLowerCase();

        await pool.query(
          `
          INSERT INTO
          ${DB_SCHEMA}.push_journal_voucher_entries
          (
            voucher_id,
            ledger_name,
            amount,
            entry_type,
            description,
            created_at,
            updated_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            NOW(),
            NOW()
          )
          `,
          [
            voucherId,
            entry.ledger_name,
            Number(entry.amount),
            type,
            entry.description || null
          ]
        );
      }

      // -----------------------------
      // ADD BULLMQ JOB
      // -----------------------------

      const job =
        await journalVoucherQueue.add(
          "push-journal-voucher",
          {
            voucherId,
            userId
          },
          {
            attempts: 5,

            backoff: {
              type: "exponential",
              delay: 5000
            },

            removeOnComplete: 100,
            removeOnFail: 100
          }
        );

      return res.status(202).json({
        success: true,
        message:
          "Journal voucher queued successfully",

        voucherId,

        jobId: job.id,

        status: "pending",

        totalDebit,
        totalCredit
      });

    } catch (error) {
      console.error(
        "Journal voucher API error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to create journal voucher",
        error: error.message
      });
    }
  }
);

export default router;