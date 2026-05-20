import express from "express";

import pool
from "../db/index.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API
========================================= */

router.get(

  "/stock/group-summary",

  async (req, res) => {

    try {

      /* =====================================
         COMPANY
      ===================================== */

      const company =
        req.query.company;

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company required"

        });

      }

      /* =====================================
         DATABASE
      ===================================== */

      const result =

        await pool.query(

          `
          SELECT

            company_name,

            group_name,

            item_name,

            hsn_code,

            quantity,

            stock_value,

            created_at

          FROM
          app.stock_group_summary

          WHERE
          company_name = $1

          ORDER BY
          id DESC
          `,

          [company]

        );

      /* =====================================
         RESPONSE
      ===================================== */

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