import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API

   Accepts EITHER company_id (preferred) OR company_name.

   GET /api/stock/group-summary?company_id=1
   GET /api/stock/group-summary?company_id=1&gstin=27ABCDE1234F1Z5
   GET /api/stock/group-summary?company_id=1&state_code=27
   GET /api/stock/group-summary?company_name=ABC%20Traders          (legacy)

   Why company_id is preferred:
   The frontend (api/tally.js -> getStockGroupSummary) sends company_id, and
   ids are stable. Matching on the company NAME is fragile in this project —
   names like "Sai Sanjivani Enterprise (Eicher Workshop) - (from 1-Apr-26)"
   have already been truncated upstream, and a truncated name silently
   returns "no stock group summary found" instead of an obvious error.

   When company_id is supplied we resolve it to the canonical name from the
   companies table, then query stock_group_summary by that name (that table
   stores company_name, not company_id).
========================================= */

router.get("/stock/group-summary", async (req, res) => {
  try {
    const companyIdParam = (req.query.company_id || "").toString().trim();
    let companyName = (req.query.company_name || "").trim();
    let resolvedBy;

    if (companyIdParam) {

      const companyId = Number(companyIdParam);

      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "company_id must be a positive integer",
        });
      }

      const companyRow = await pool.query(
        `SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`,
        [companyId]
      );

      if (!companyRow.rows.length) {
        return res.status(404).json({
          status: "error",
          message: `Company id ${companyId} not found`,
        });
      }

      companyName = (companyRow.rows[0].name || "").trim();
      resolvedBy = "company_id";

    } else if (companyName) {

      resolvedBy = "company_name";

    } else {

      return res.status(400).json({
        status: "error",
        message: "company_id or company_name required",
      });

    }

    // ---------------------------------------
    // Determine customer state (from query)
    // ---------------------------------------
    const gstin = (req.query.gstin || "").trim();
    const stateCodeFromQuery = (req.query.state_code || "").trim();

    const isValidGstinPrefix = /^[0-9]{2}/.test(gstin);
    const customerStateCode =
      stateCodeFromQuery ||
      (isValidGstinPrefix ? gstin.substring(0, 2) : null);

    // ---------------------------------------
    // Determine company's own state from DB (company_details)
    // ---------------------------------------
    const companyResult = await pool.query(
      `SELECT gstin, state FROM ${DB_SCHEMA}.company_details WHERE TRIM(company_name) = TRIM($1)`,
      [companyName]
    );

    let companyGSTIN = null;
    let companyStateCode = null;

    if (companyResult.rows.length) {
      companyGSTIN = companyResult.rows[0].gstin || null;
      if (companyGSTIN && /^[0-9]{2}/.test(companyGSTIN)) {
        companyStateCode = companyGSTIN.substring(0, 2);
      }
    }

    // last-resort fallback if company gstin missing/invalid
    if (!companyStateCode) {
      companyStateCode = "27";
    }

    const isSameState =
      customerStateCode === null
        ? true
        : customerStateCode === companyStateCode;

    const stateSource = stateCodeFromQuery
      ? "state_code_param"
      : gstin
      ? "gstin"
      : "no_customer_state_provided";

    const result = await pool.query(
      `
      SELECT
        company_name, group_name, item_name, hsn_code,
        quantity, stock_value, gst_rate, cgst_rate, sgst_rate, igst_rate,
        rate, created_at
      FROM ${DB_SCHEMA}.stock_group_summary
      WHERE TRIM(company_name) = TRIM($1)
      ORDER BY id DESC
      `,
      [companyName]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        company_name: companyName,
        resolved_by: resolvedBy,
        message: "No stock group summary found",
        total: 0,
        data: [],
      });
    }

    const data = result.rows.map((row) => {
      const stockValue = Math.abs(Number(row.stock_value) || 0);
      const taxableAmount = Number(row.rate) || stockValue;

      const storedCgstRate = Number(row.cgst_rate) || 0;
      const storedSgstRate = Number(row.sgst_rate) || 0;
      const storedIgstRate = Number(row.igst_rate) || 0;

      const hasStoredRates =
        storedCgstRate > 0 || storedSgstRate > 0 || storedIgstRate > 0;

      let cgstRate, sgstRate, igstRate;

      if (hasStoredRates) {
        cgstRate = storedCgstRate;
        sgstRate = storedSgstRate;
        igstRate = storedIgstRate;
      } else {
        const gstRate = Number(row.gst_rate) || 0;

        if (isSameState) {
          cgstRate = gstRate / 2;
          sgstRate = gstRate / 2;
          igstRate = 0;
        } else {
          cgstRate = 0;
          sgstRate = 0;
          igstRate = gstRate;
        }
      }

      const cgst = Number(((taxableAmount * cgstRate) / 100).toFixed(2));
      const sgst = Number(((taxableAmount * sgstRate) / 100).toFixed(2));
      const igst = Number(((taxableAmount * igstRate) / 100).toFixed(2));

      return {
        ...row,
        cgst_rate: cgstRate,
        sgst_rate: sgstRate,
        igst_rate: igstRate,
        cgst,
        sgst,
        igst,
        rate_source: hasStoredRates ? "tally_item_rate" : "state_split_fallback",
      };
    });

    return res.status(200).json({
      status: "success",
      source: "database",
      company_name: companyName,
      resolved_by: resolvedBy,
      company_gstin: companyGSTIN,
      company_state_code: companyStateCode,
      customer_state_code: customerStateCode,
      state_source: stateSource,
      total: data.length,
      data,
    });
  } catch (err) {
    console.log("STOCK GROUP SUMMARY API ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;