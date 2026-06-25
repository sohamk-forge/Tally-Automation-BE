import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API
=========================================

API:
GET /api/stock/group-summary?company_id=1

========================================= */

router.get(

  "/stock/group-summary",

  async (req, res) => {

    try {

      /* =====================================
         COMPANY ID
      ===================================== */

      const companyId =
        req.query.company_id;

      if (!companyId) {

        return res.status(400).json({

          status: "error",

          message:
            "company_id required"

        });

      }

      /* =====================================
         DATABASE
      ===================================== */

      const result = await pool.query(

        `
        SELECT

          company_id,

          company_name,

          group_name,

          item_name,

          hsn_code,

          quantity,

          stock_value,

          created_at

        FROM app_test.stock_group_summary

        WHERE company_id = $1

        ORDER BY id DESC
        `,

        [companyId]

      );

      /* =====================================
         NO DATA
      ===================================== */

      if (!result.rows.length) {

        return res.status(404).json({

          status: "error",

          source: "database",

          company_id:
            companyId,

          message:
            "No stock group summary found",

          total: 0,

          data: []

        });

      }

      /* =====================================
         RESPONSE
      ===================================== */

      return res.status(200).json({

        status: "success",

        source: "database",

        company_id:
          companyId,

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(

        "❌ STOCK GROUP SUMMARY API ERROR:",

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