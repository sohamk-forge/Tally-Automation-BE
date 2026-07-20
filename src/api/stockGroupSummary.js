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

      /* =====================================
         COMPUTE CGST / SGST FOR FRONTEND
      ===================================== */
      const data = result.rows.map((row) => {

        const stockValue = Math.abs(Number(row.stock_value) || 0);
        const gstRate = Number(row.gst_rate) || 0;

        const cgst = Number(
          ((stockValue * (gstRate / 2)) / 100).toFixed(2)
        );
        const sgst = cgst;

        return {
          ...row,
          cgst,
          sgst
        };

      });

      return res.status(200).json({
        status: "success",
        source: "database",
        company_id: companyId,
        total: data.length,
        data
      });

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