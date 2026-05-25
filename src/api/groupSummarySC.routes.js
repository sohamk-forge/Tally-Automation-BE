import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   GROUP SUMMARY SC DB API
===================================================

API:
GET /api/group-summary/sc/sundry-creditors

=================================================== */

router.get(
  "/",
  async (req, res) => {

    try {

      const company =
        req.query.company;

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company query parameter required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =
        await pool.query(

          `
          SELECT *

        FROM app_test.sundry_creditors

          WHERE company_name = $1

          ORDER BY ledger_name ASC
          `,

          [company]

        );

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY SC DB ERROR:",
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