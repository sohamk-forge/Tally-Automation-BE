import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   PURCHASE SALES LEDGERS DB API

   GET /api/purchase-sales-ledgers?company_id=1
=================================================== */

router.get(
  "/purchase-sales-ledgers",
  async (req, res) => {
    try {

      const companyId =
        req.query.company_id;

      if (!companyId) {
        return res.status(400).json({
          status: "error",
          message:
            "company_id query parameter required"
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            company_id,
            ledger_name,
            parent_group,
            ledger_type,
            created_at,
            updated_at
          FROM ${DB_SCHEMA}.company_purchase_sales_ledgers
          WHERE company_id = $1
          ORDER BY ledger_name
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
        "❌ PURCHASE SALES LEDGER DB ERROR:",
        err.message
      );

      return res.status(500).json({
        status: "error",
        message: err.message
      });

    }
  }
);

export default router;