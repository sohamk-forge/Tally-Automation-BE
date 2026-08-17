import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { ledgerQueue } from "../queues/ledger.queue.js";

import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

const router = express.Router();

router.post(
  "/push/ledger",
  verifySession(),
  async (req, res) => {
    try {
      // =====================================================
      // 1. GET LOGGED-IN USER
      // =====================================================

      const userId = await getLocalUserId(
        req.session.getUserId()
      );

      if (!userId) {
        return res.status(404).json({
          status: "error",
          message: "No profile found for this account"
        });
      }

      // =====================================================
      // 2. REQUEST DATA
      // =====================================================

      const data = req.body;

      if (
        !data.company_id ||
        !data.company ||
        !data.ledger_name ||
        !data.parent
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "company_id, company, ledger_name and parent are required"
        });
      }

      const companyId = Number(data.company_id);

      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid company_id"
        });
      }

      console.log("========== PUSH LEDGER ==========");
      console.log("Request userId:", userId);
      console.log("Request companyId:", companyId);
      console.log("Request company:", data.company);
      console.log("Ledger:", data.ledger_name);

      // =====================================================
      // 3. GET EXACT COMPANY BY ID
      // =====================================================

      const companyResult = await pool.query(
        `
        SELECT
          id,
          name
        FROM ${DB_SCHEMA}.companies
        WHERE id = $1
        LIMIT 1
        `,
        [companyId]
      );

      if (companyResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: `Company not found: ${companyId}`
        });
      }

      const company = companyResult.rows[0];

      console.log("✅ COMPANY SELECTED:", {
        companyId: company.id,
        companyName: company.name,
        userId
      });

      // =====================================================
      // 4. DUPLICATE CHECK
      //    IMPORTANT: CHECK COMPANY_ID TOO
      // =====================================================

      const duplicateResult = await pool.query(
        `
        SELECT id
        FROM ${DB_SCHEMA}.push_ledger
        WHERE company_id = $1
          AND LOWER(TRIM(ledger_name))
              = LOWER(TRIM($2))
          AND status IN (
            'pending',
            'processing',
            'success'
          )
        LIMIT 1
        `,
        [
          companyId,
          data.ledger_name
        ]
      );

      if (duplicateResult.rows.length > 0) {
        return res.status(400).json({
          status: "error",
          message: "Ledger already queued or synced"
        });
      }

      // =====================================================
      // 5. INSERT PUSH LEDGER
      // =====================================================

      const insertResult = await pool.query(
        `
        INSERT INTO ${DB_SCHEMA}.push_ledger
        (
          company_id,
          company_name,
          ledger_name,
          parent_name,
          opening_balance,
          bill_wise,
          address,
          pincode,
          state,
          country,
          contact_person,
          phone,
          mobile,
          email,
          website,
          pan,
          gstin,
          gst_registration_type,
          status,
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
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          'pending',
          NOW(),
          NOW()
        )
        RETURNING id
        `,
        [
          companyId,
          company.name,
          data.ledger_name?.trim(),
          data.parent?.trim(),
          Number(data.opening_balance || 0),
          data.bill_wise || "No",
          data.address || "",
          data.pincode || "",
          data.state || "",
          data.country || "India",
          data.contact_person || "",
          data.phone || "",
          data.mobile || "",
          data.email || "",
          data.website || "",
          data.pan || "",
          data.gstin || "",
          data.gst_registration_type || ""
        ]
      );

      const ledgerId = insertResult.rows[0].id;

      // =====================================================
      // 6. ADD BULLMQ JOB
      // =====================================================

      const job = await ledgerQueue.add(
        "push-ledger",
        {
          ledgerId,
          userId,
          companyId
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

      console.log("📥 LEDGER QUEUED:", {
        ledgerId,
        userId,
        companyId,
        jobId: job.id
      });

      return res.status(200).json({
        status: "success",
        message: "Ledger queued successfully",
        ledgerId,
        jobId: job.id,
        userId,
        companyId
      });

    } catch (err) {
      console.error(
        "❌ PUSH LEDGER ERROR:",
        err
      );

      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  }
);

export default router;