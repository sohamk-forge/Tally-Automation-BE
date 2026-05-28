// =========================================
// src/api/pushLedger.routes.js
// =========================================

import express from "express";

import pool
from "../db/index.js";

const router =
  express.Router();

/* =====================================
   PUSH LEDGER API
===================================== */

router.post(

  "/push/ledger",

  async (req, res) => {

    try {

      /* ==============================
         REQUEST BODY
      ============================== */

      const data =
        req.body;

      /* ==============================
         VALIDATION
      ============================== */

      if (
        !data.company ||
        !data.ledger_name ||
        !data.parent
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, ledger_name and parent are required"

        });

      }

      /* ==============================
         COMPANY ID
      ============================== */

      const companyResult =

        await pool.query(

          `
          SELECT id

          FROM app_test.companies

          WHERE TRIM(name) = TRIM($1)
          `,

          [

            data.company

          ]

        );

      const companyId =

        companyResult.rows[0]?.id || null;

      /* ==============================
         DUPLICATE CHECK
      ============================== */

      const duplicateResult =

        await pool.query(

          `
          SELECT id

          FROM app_test.push_ledger

          WHERE TRIM(company_name) = TRIM($1)

          AND TRIM(ledger_name) = TRIM($2)

          AND status IN ('pending', 'success')
          `,

          [

            data.company,

            data.ledger_name

          ]

        );

      if (duplicateResult.rows.length) {

        return res.status(400).json({

          status: "error",

          message:
            "Ledger already queued or synced"

        });

      }

      /* ==============================
         INSERT PENDING RECORD
      ============================== */

      await pool.query(

        `
        INSERT INTO app_test.push_ledger (

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

        VALUES (

          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19,
          NOW(),
          NOW()

        )
        `,

        [

          companyId,

          data.company?.trim(),

          data.ledger_name?.trim(),

          data.parent?.trim(),

          data.opening_balance || 0,

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

          data.gst_registration_type || "",

          "pending"

        ]

      );

      /* ==============================
         SUCCESS RESPONSE
      ============================== */

      return res.status(200).json({

        status: "success",

        message:
          "Ledger queued successfully"

      });

    } catch (err) {

      console.log(

        "❌ PUSH LEDGER ERROR:",

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