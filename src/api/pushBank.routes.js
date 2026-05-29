// =========================================
// src/api/pushBank.routes.js
// =========================================

import express from "express";

import pool
from "../db/index.js";

const router =
  express.Router();

/* =========================================
   PUSH BANK LEDGER API
========================================= */

router.post(

  "/push-bank",

  async (req, res) => {

    try {

      /* =====================================
         REQUEST BODY
      ===================================== */

      const {

        company,

        ledger_name,

        opening_balance,

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

        !bank_name ||

        !account_number ||

        !ifsc_code

      ) {

        return res.status(400).json({

          status:
            "error",

          message:
            "company, ledger_name, bank_name, account_number and ifsc_code required"

        });

      }

      /* =====================================
         DUPLICATE CHECK
      ===================================== */

      const existing =

        await pool.query(

          `
          SELECT id

          FROM app_test.push_bank

          WHERE LOWER(TRIM(ledger_name))
          = LOWER(TRIM($1))

          AND sync_status IN
          ('pending', 'success')

          LIMIT 1
          `,

          [

            ledger_name

          ]

        );

      if (existing.rows.length > 0) {

        return res.status(400).json({

          status:
            "error",

          message:
            "Bank ledger already queued or synced"

        });

      }

      /* =====================================
         INSERT QUEUE RECORD
      ===================================== */

      await pool.query(

        `
        INSERT INTO app_test.push_bank
        (

          company_name,

          ledger_name,

          parent_group,

          opening_balance,

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

          $1,  $2,  $3,  $4,
          $5,  $6,  $7,  $8,
          $9,  $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          NOW(),
          NOW()

        )
        `,

        [

          company?.trim(),

          ledger_name?.trim(),

          "Bank Accounts",

          opening_balance || 0,

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

      /* =====================================
         SUCCESS RESPONSE
      ===================================== */

      return res.status(200).json({

        status:
          "success",

        message:
          "Bank ledger queued successfully"

      });

    } catch (err) {

      console.log(

        "❌ PUSH BANK ERROR:",

        err.message

      );

      return res.status(500).json({

        status:
          "error",

        message:
          err.message

      });

    }

  }

);

export default router;