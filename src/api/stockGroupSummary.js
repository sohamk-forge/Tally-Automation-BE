import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API

   GET /api/stock/group-summary?company_id=1&gstin=27ABCDE1234F1Z5
   GET /api/stock/group-summary?company_id=1&state_code=27
   GET /api/stock/group-summary?company_id=1   (no gstin/state_code => defaults to Maharashtra, CGST/SGST)
========================================= */

router.get(

  "/stock/group-summary",

  async (req, res) => {

    try {

      const companyId = req.query.company_id;

      if (!companyId) {
        return res.status(400).json({
          status: "error",
          message: "company_id required"
        });
      }

      // ---- Step 2: read GSTIN / state code ----
      const gstin = (req.query.gstin || "").trim();
      const stateCodeFromQuery = (req.query.state_code || "").trim();

      // Only trust the GSTIN-derived state code if the GSTIN looks valid
      // (basic check: at least 2 digits at the start)
      const isValidGstinPrefix = /^[0-9]{2}/.test(gstin);
      const stateCodeFromGstin = isValidGstinPrefix
        ? gstin.substring(0, 2)
        : "";

      // Priority: explicit state_code param > derived from gstin > default (Maharashtra)
      const stateCode =
        stateCodeFromQuery || stateCodeFromGstin || "27";

      // No GSTIN/state info at all => assume Maharashtra => CGST/SGST
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
          rate,
          created_at

        FROM app_test.stock_group_summary

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
          data: []
        });
      }

      /* ================================================
         ⬇️ CGST / SGST / IGST COMPUTED DYNAMICALLY ⬇️
         based on gst_rate stored in DB + customer's state
      ================================================ */

      const data = result.rows.map((row) => {
        const stockValue = Math.abs(Number(row.stock_value) || 0);
        const taxableAmount = Number(row.rate) || stockValue;

        const gstRate = Number(row.gst_rate) || 0;

        let cgstRate = 0;
        let sgstRate = 0;
        let igstRate = 0;

        if (isMaharashtra) {
          cgstRate = gstRate / 2;
          sgstRate = gstRate / 2;
        } else {
          igstRate = gstRate;
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
          igst
        };
      });

      return res.status(200).json({
        status: "success",
        source: "database",
        company_id: companyId,
        state_code: stateCode,
        state_source: stateSource,
        total: data.length,
        data
      });

      /* ================================================
         ⬆️ END OF NEW CODE ⬆️
      ================================================ */

    } catch (err) {

      console.log(
        "❌ STOCK GROUP SUMMARY API ERROR:",
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