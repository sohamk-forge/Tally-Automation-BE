import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const company = req.query.company;
    // Prefer company_id: several companies rows can share one name (one per
    // user pairing), so a name lookup can return another row's balance.
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;

    if (!companyId && !company) {
      return res.status(400).json({
        success: false,
        message: "company_id or company query parameter is required"
      });
    }

    // group_balances stores one row per synced group (Sundry Debtors,
    // Sundry Creditors, Stock-in-Hand, ...) with the exact closing_balance
    // Tally reported for that group — no per-ledger summing needed.
    // Match case-insensitively and allow the "Stock in Hand" (no hyphen)
    // spelling Tally sometimes uses, same as getStockInHandXML's filter.
    const result = await pool.query(
      `SELECT closing_balance, opening_balance, updated_at
         FROM ${DB_SCHEMA}.group_balances
        WHERE ${companyId ? "company_id = $1" : "LOWER(company_name) = LOWER($1)"}
          AND LOWER(REPLACE(group_name, ' ', '-')) = 'stock-in-hand'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [companyId || company]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: `No "Stock-in-Hand" group balance found for "${companyId || company}". Run /payable-debtors sync first.`
      });
    }

    const { closing_balance, opening_balance, updated_at } = result.rows[0];

    return res.status(200).json({
      success: true,
      company_id: companyId,
      company,
      stock_value: Math.abs(Number(closing_balance)),
      opening_stock_value: Math.abs(Number(opening_balance)),
      last_synced_at: updated_at,
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