import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   PROFIT LOSS DB API
===================================================

API:
GET /api/profit-loss?company_id=1

=================================================== */

router.get(

  "/profit-loss",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
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

      const result =

        await pool.query(

          `
          SELECT

            id,

            company_id,

            company_name,

            from_date,

            to_date,

            total_sales,

            total_purchase,

            stock_value,

            gross_profit,

            net_profit,

            profit_margin,

            created_at,

            updated_at

          FROM app_test.profit_loss

          WHERE company_id = $1

          ORDER BY id DESC

          LIMIT 1
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

          message:
            "No profit loss data found",

          company_id:
            companyId,

          data: []

        });

      }

      /* =========================================
         FINAL CLEAN DATA
      ========================================= */

      const row =
        result.rows[0];

      /* =========================================
         SUCCESS RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company_id:
          companyId,

        dashboard: {

          id:
            Number(row.id),

          company_id:
            row.company_id,

          company_name:
            row.company_name,

          from_date:
            row.from_date,

          to_date:
            row.to_date,

          total_sales:
            Number(
              row.total_sales
            ),

          total_purchase:
            Number(
              row.total_purchase
            ),

          stock_value:
            Number(
              row.stock_value
            ),

          gross_profit:
            Number(
              row.gross_profit
            ),

          net_profit:
            Number(
              row.net_profit
            ),

          profit_margin:
            Number(
              row.profit_margin
            ),

          created_at:
            row.created_at,

          updated_at:
            row.updated_at

        }

      });

    } catch (err) {

      console.log(

        "❌ PROFIT LOSS DB ERROR:",

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