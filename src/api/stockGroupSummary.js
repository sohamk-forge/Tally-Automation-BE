import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   STOCK GROUP SUMMARY API

   GET /api/stock/group-summary?company_id=1
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
          data: []
        });
      }

      /* ================================================
         ⬇️ CGST / SGST / IGST NOW COME DIRECTLY FROM DB ⬇️
         (populated by the stock-group-summary-sync route
          from Tally's RATEDETAILS.LIST, no on-the-fly split)
      ================================================ */

      const data = result.rows.map((row) => {
        const stockValue = Math.abs(Number(row.stock_value) || 0);
        const taxableAmount = Number(row.rate) || stockValue;

        const cgstRate = Number(row.cgst_rate) || 0;
        const sgstRate = Number(row.sgst_rate) || 0;
        const igstRate = Number(row.igst_rate) || 0;

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