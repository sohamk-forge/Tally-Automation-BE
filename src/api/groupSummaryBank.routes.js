import express from "express";

import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   GROUP SUMMARY BANK DB API
===================================================

API:
GET /api/group-summary-bank

=================================================== */

router.get(

  "/",

  async (req, res) => {

    try {

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =

        await pool.query(

          `
          SELECT *

          FROM app.bank_accounts

          ORDER BY ledger_name ASC
          `
        );

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(

        "❌ GROUP SUMMARY BANK DB ERROR:",

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