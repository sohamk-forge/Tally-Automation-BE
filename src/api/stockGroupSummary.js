import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API

   GET /api/stock/group-summary?company_id=1&gstin=27ABCDE1234F1Z5
   GET /api/stock/group-summary?company_id=1&state_code=27
   GET /api/stock/group-summary?company_id=1
========================================= */

router.get("/stock/group-summary", async (req, res) => {
  try {
    const companyId = req.query.company_id;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "company_id required",
      });
    }

    // ---------------------------------------
    // Determine customer state
    // ---------------------------------------
    const gstin = (req.query.gstin || "").trim();
    const stateCodeFromQuery = (req.query.state_code || "").trim();

    const isValidGstinPrefix = /^[0-9]{2}/.test(gstin);
    const stateCodeFromGstin = isValidGstinPrefix
      ? gstin.substring(0, 2)
      : "";

    const stateCode =
      stateCodeFromQuery || stateCodeFromGstin || "27";

    const isMaharashtra = stateCode === "27";

    const stateSource = stateCodeFromQuery
      ? "state_code_param"
      : stateCodeFromGstin
      ? "gstin"
      : "default_maharashtra";

    const result = await pool.query(
      `
      SELECT
        company_id,
        company_name,
        group_name,
        item_name,
        hsn_code,
        quantity,
        stock_value,
        gst_rate,
        cgst_rate,
        sgst_rate,
        igst_rate,
        rate,
        created_at
      FROM ${DB_SCHEMA}.stock_group_summary
      WHERE company_id = $1
      ORDER BY id DESC
      `,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        company_id: companyId,
        message: "No stock group summary found",
        total: 0,
        data: [],
      });
    }

    /* ================================================
       Use stored GST rates if available.
       Otherwise split GST based on customer state.
    ================================================ */

    const data = result.rows.map((row) => {
      const stockValue = Math.abs(Number(row.stock_value) || 0);
      const taxableAmount = Number(row.rate) || stockValue;

      const storedCgstRate = Number(row.cgst_rate) || 0;
      const storedSgstRate = Number(row.sgst_rate) || 0;
      const storedIgstRate = Number(row.igst_rate) || 0;

      const hasStoredRates =
        storedCgstRate > 0 ||
        storedSgstRate > 0 ||
        storedIgstRate > 0;

      let cgstRate;
      let sgstRate;
      let igstRate;

      if (hasStoredRates) {
        // Use Tally rates stored in DB
        cgstRate = storedCgstRate;
        sgstRate = storedSgstRate;
        igstRate = storedIgstRate;
      } else {
        // Legacy fallback
        const gstRate = Number(row.gst_rate) || 0;

        if (isMaharashtra) {
          cgstRate = gstRate / 2;
          sgstRate = gstRate / 2;
          igstRate = 0;
        } else {
          cgstRate = 0;
          sgstRate = 0;
          igstRate = gstRate;
        }
      }

      const cgst = Number(
        ((taxableAmount * cgstRate) / 100).toFixed(2)
      );

      const sgst = Number(
        ((taxableAmount * sgstRate) / 100).toFixed(2)
      );

      const igst = Number(
        ((taxableAmount * igstRate) / 100).toFixed(2)
      );

      return {
        ...row,
        cgst_rate: cgstRate,
        sgst_rate: sgstRate,
        igst_rate: igstRate,
        cgst,
        sgst,
        igst,
        rate_source: hasStoredRates
          ? "tally_item_rate"
          : "state_split_fallback",
      };
    });

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      state_code: stateCode,
      state_source: stateSource,
      total: data.length,
      data,
    });
  } catch (err) {
    console.log("❌ STOCK GROUP SUMMARY API ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;