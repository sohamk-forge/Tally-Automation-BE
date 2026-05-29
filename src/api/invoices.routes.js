import express from "express";

import pool
from "../db/index.js";

const router =
  express.Router();

/* =========================================
   SAVE OCR / LLM JSON
========================================= */

router.post(

  "/invoices",

  async (req, res) => {

    try {

      const {

        company,

        invoice_data

      } = req.body;

      if (

        !company ||

        !invoice_data

      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company and invoice_data required"

        });

      }

      await pool.query(

        `
        INSERT INTO
        app_test.invoice_extractions
        (

          company_name,

          vendor_name,

          gstin,

          invoice_no,

          invoice_date,

          raw_json,

          sync_status,

          created_at,

          updated_at

        )

        VALUES
        (

          $1,$2,$3,$4,$5,$6,
          'pending',
          NOW(),
          NOW()

        )
        `,

        [

          company,

          invoice_data.vendor_name || "",

          invoice_data.gstin || "",

          invoice_data.invoice_no || "",

          invoice_data.invoice_date || "",

          JSON.stringify(
            invoice_data
          )

        ]

      );

      return res.status(200).json({

        status: "success",

        message:
          "Invoice stored successfully"

      });

    } catch (err) {

      console.log(

        "INVOICE ERROR:",

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