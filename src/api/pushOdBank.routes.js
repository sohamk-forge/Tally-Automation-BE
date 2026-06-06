// =========================================
// src/api/pushOdBank.routes.js
// =========================================

import express from "express";
import pool from "../db/index.js";
import {
  odBankQueue,
  OD_BANK_JOB_OPTIONS,
  getOdBankJobId
} from "../queues/odBank.queue.js";

const router = express.Router();

/* =========================================
   PUSH OD / OCC BANK LEDGER
========================================= */

router.post(

  "/push-od-bank",

  async (req, res) => {

    try {

      const {

        company,
        ledger_name,
        account_type,
        opening_balance,
        od_limit,
        bank_name,
        branch_name,
        account_holder,
        account_number,
        ifsc_code,
        swift_code,
        address,
        state,
        country,
        pincode,
        contact_person,
        mobile,
        email

      } = req.body;

      /* =====================================
         VALIDATION
      ===================================== */

      if (
        !company ||
        !ledger_name ||
        !account_type
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, ledger_name and account_type required"

        });

      }

      /* =====================================
         DUPLICATE CHECK
      ===================================== */

      const existing = await pool.query(

        `
        SELECT id

        FROM app_test.bank_od_accounts

        WHERE LOWER(TRIM(ledger_name))
        = LOWER(TRIM($1))

        AND sync_status IN
        ('pending','success')

        LIMIT 1
        `,

        [
          ledger_name
        ]

      );

      if (existing.rows.length > 0) {

        return res.status(400).json({

          status: "error",

          message:
            "OD/OCC ledger already queued or synced"

        });

      }

      /* =====================================
         INSERT QUEUE
      ===================================== */

      const insertResult = await pool.query(

        `
        INSERT INTO app_test.bank_od_accounts
        (

          company_name,
          ledger_name,
          account_type,
          opening_balance,
          od_limit,
          bank_name,
          branch_name,
          account_holder,
          account_number,
          ifsc_code,
          swift_code,
          address,
          state,
          country,
          pincode,
          contact_person,
          mobile,
          email,
          sync_status,
          created_at,
          updated_at

        )

        VALUES
        (

          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,$18,
          $19,
          NOW(),
          NOW()

        )
        RETURNING id
        `,

        [

          company?.trim(),

          ledger_name?.trim(),

          account_type?.trim(),

          opening_balance || 0,

          od_limit || 0,

          bank_name || "",

          branch_name || "",

          account_holder || "",

          account_number || "",

          ifsc_code || "",

          swift_code || "",

          address || "",

          state || "",

          country || "India",

          pincode || "",

          contact_person || "",

          mobile || "",

          email || "",

          "pending"

        ]

      );

      const odBankId = insertResult.rows[0].id;

      await odBankQueue.add(
        "push-od-bank",
        { odBankId },
        {
          ...OD_BANK_JOB_OPTIONS,
          jobId: getOdBankJobId(odBankId)
        }
      );

      return res.status(200).json({

        status: "success",

        message:
          "OD/OCC ledger queued successfully"

      });

    } catch (err) {

      console.log(
        "PUSH OD BANK ERROR:",
        err.message
      );

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;
