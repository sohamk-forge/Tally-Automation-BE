/**
 * src/api/party-transactions.routes.js
 *
 * Register in app.js:
 *   import partyTransactionsRoutes from "./api/party-transactions.routes.js";
 *   app.use("/api/v1/party-transactions", partyTransactionsRoutes);
 *
 * ─────────────────────────────────────────────────────────────────
 * CHALLAN-ONLY — no app_test.vouchers involved at all.
 * ─────────────────────────────────────────────────────────────────
 *
 * GET /api/v1/party-transactions
 *   ?company_id=1
 *   &fromDate=2020-04-01
 *   &toDate=2021-03-31
 *   &party=ABC Traders        ← optional
 *   &status=DRAFT             ← optional
 *
 * Returns challans reshaped to match EXACTLY the columns of the
 * Transactions table (Date, Voucher No., Type, Party, Narration,
 * Debit, Credit, Balance) — nothing more, nothing less.
 *
 * type is always "Challan". debit / credit / balance are always
 * present on the row, set to null (never dropped) — Challans don't
 * move the party's running balance, so the frontend renders an
 * empty cell for those three columns.
 */

import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const {
      company_id,
      fromDate,
      toDate,
      party,
      status,
    } = req.query;

    /* ============================
       VALIDATION
    ============================ */

    if (!company_id || !fromDate || !toDate) {
      return res.status(400).json({
        status: "error",
        message: "company_id, fromDate and toDate required",
      });
    }

    /* ============================
       CHALLANS
    ============================ */

    const conditions = [
      "company_id = $1",
      "DATE(challan_date) BETWEEN $2 AND $3",
    ];
    const values = [company_id, fromDate, toDate];
    let idx = 4;

    if (party && party !== "undefined" && party !== "null") {
      conditions.push(`LOWER(customer_name) LIKE LOWER($${idx})`);
      values.push(`%${party}%`);
      idx++;
    }

    if (status) {
      conditions.push(`status = $${idx}`);
      values.push(String(status).toUpperCase());
      idx++;
    }

    const result = await pool.query(
      `SELECT
         challan_date,
         challan_number,
         customer_name,
         narration
       FROM ${DB_SCHEMA}.challans
       WHERE ${conditions.join(" AND ")}
       ORDER BY challan_date DESC, id DESC`,
      values
    );

    // Reshape to exactly the 8 Transactions-table columns.
    // debit / credit / balance kept explicit and null — never omitted —
    // so the frontend renders an empty cell instead of a missing column.
    const data = result.rows.map((row) => ({
      date:      row.challan_date,
      voucher_no: row.challan_number,
      type:      "Challan",
      party:     row.customer_name,
      narration: row.narration,
      debit:     null,
      credit:    null,
      balance:   null,
    }));

    return res.status(200).json({
      status: "success",
      company_id,
      fromDate,
      toDate,
      total: data.length,
      data,
    });
  } catch (err) {
    console.log("❌ PARTY TRANSACTIONS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;