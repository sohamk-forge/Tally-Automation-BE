import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   GROUP SUMMARY BANK DB API
===================================================

API:
GET /api/group-summary-bank?company_id=1

=================================================== */

router.get(

  "/",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAM
      ========================================= */

      const companyId =
        req.query.company_id;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!companyId) {

        return res.status(400).json({

          status: "error",

          message:
            "company_id query parameter required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result = await pool.query(

        `
        SELECT *

        FROM ${DB_SCHEMA}.bank_accounts

        WHERE company_id = $1

        ORDER BY ledger_name ASC
        `,

        [companyId]

      );

      /* =========================================
         NO DATA
      ========================================= */

      if (!result.rows.length) {

        return res.status(404).json({

          status: "error",

          source: "database",

          company_id: companyId,

          message:
            "No bank accounts found",

          total: 0,

          data: []

        });

      }

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company_id: companyId,

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