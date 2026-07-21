import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company query parameter is required"
      });
    }

    const result = await pool.query(
      `SELECT closing_balance, closing_balance_type
         FROM ${DB_SCHEMA}.all_ledger_details
        WHERE LOWER(company_name) = LOWER($1)
          AND LOWER(parent_group) LIKE '%stock-in-hand%'`,
      [company]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: `No "Stock-in-Hand" group ledgers found for "${company}"`
      });
    }

    let closingBalance = 0;
    for (const row of result.rows) {
      closingBalance += Number(row.closing_balance) || 0;
    }

    return res.status(200).json({
      success: true,
      company,
      stock_value: Math.abs(Number(closingBalance.toFixed(2))),
      source: "database"
    });

  } catch (err) {
    console.error("stock-in-hand closing-balance error:", err.message);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;