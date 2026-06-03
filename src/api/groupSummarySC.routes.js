  import express from "express";
  import pool from "../db/index.js";

  const router = express.Router();

  /* ===================================================
    GROUP SUMMARY SC DB API
  ===================================================

  API:
  GET /api/group-summary/sc/sundry-creditors?company_id=2

  =================================================== */

  router.get("/", async (req, res) => {

    try {

      const companyId = req.query.company_id;

      if (!companyId) {

        return res.status(400).json({

          status: "error",

          message: "company_id query parameter required"

        });

      }

      const result = await pool.query(

        `
        SELECT *
        FROM app_test.sundry_creditors
        WHERE company_id = $1
        ORDER BY ledger_name ASC
        `,

        [companyId]

      );

      return res.status(200).json({

        status: "success",

        source: "database",

        company_id: companyId,

        total: result.rows.length,

        data: result.rows

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY SC DB ERROR:",
        err.message
      );

      return res.status(500).json({

        status: "error",

        message: err.message

      });

    }

  });

  export default router;