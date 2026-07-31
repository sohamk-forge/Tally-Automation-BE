import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API

   GET /api/stock/group-summary?company_name=ABC%20Traders&gstin=27ABCDE1234F1Z5
   GET /api/stock/group-summary?company_name=ABC%20Traders&state_code=27
   GET /api/stock/group-summary?company_name=ABC%20Traders
========================================= */

router.get("/stock/group-summary", async (req, res) => {
  try {
    const companyName = (req.query.company_name || "").trim();

    if (!companyName) {
      return res.status(400).json({
        status: "error",
        message: "company_name required",
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
      `SELECT gstin, state FROM ${DB_SCHEMA}.company_details WHERE company_name = $1`,
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
      WHERE company_name = $1
      ORDER BY id DESC
      `,
      [companyName]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        company_name: companyName,
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
      company_gstin: companyGSTIN,
      company_state_code: companyStateCode,
      customer_state_code: customerStateCode,
      state_source: stateSource,
      total: data.length,
      data,
    });
  } catch (err) {
    console.log("❌ STOCK GROUP SUMMARY API ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;