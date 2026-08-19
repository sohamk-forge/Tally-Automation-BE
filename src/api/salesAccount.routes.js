import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ success: false, message: "company query parameter required" });
  }

  const result = await pool.query(
    `SELECT closing_balance
     FROM ${DB_SCHEMA}.group_balances
     WHERE LOWER(company_name) = LOWER($1)
       AND LOWER(group_name) = 'sales accounts'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [company]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      success: false,
      message: `No "Sales Accounts" group found for "${company}"`
    });
  }

  const closingBalance = Number(result.rows[0].closing_balance) || 0;

  return res.status(200).json({
    success: true,
    company,
    closing_balance: Number(closingBalance.toFixed(2)),
    source: "database"
  });
});

export default router;