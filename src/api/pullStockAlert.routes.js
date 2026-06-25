import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.get(
  "/pull/stock-alert",
  async (req, res) => {

    try {

      const companyId =
        req.query.company_id;

      if (!companyId) {

        return res.status(400).json({
          status: "error",
          message: "company_id is required"
        });

      }

      const result =
        await pool.query(

          `
          SELECT
            item_name,
            minimum_alert_quantity,
            current_quantity,
            shortage_quantity,
            is_low_stock

          FROM app_test.stock_alerts

          WHERE
            company_id = $1

          AND
            is_active = true

          ORDER BY
            is_low_stock DESC,
            item_name
          `,

          [companyId]

        );

      return res.json({

        status: "success",

        data: result.rows

      });

    } catch (err) {

      return res.status(500).json({

        status: "error",

        message: err.message

      });

    }

  }
);

export default router;