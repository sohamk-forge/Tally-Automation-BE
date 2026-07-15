import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   GET ALL COMPANIES (USER-FILTERED)
========================================= */
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id query parameter required"
      });
    }

    // COUNT TOTAL FOR THIS USER
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM app_test.companies c
       INNER JOIN app_test.connector_machines m
           ON c.name = m.company_name
       WHERE m.tally_connected = true AND m.user_id = $1`,
      [user_id]
    );

    const total = parseInt(totalResult.rows[0].count);

    // FETCH ONLY THIS USER'S COMPANIES
    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end,
         m.from_year,
         m.to_year
       FROM app_test.companies c
       INNER JOIN app_test.connector_machines m
           ON c.name = m.company_name
       WHERE m.tally_connected = true AND m.user_id = $1
       ORDER BY c.id DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );

    return res.json({
      status: "success",
      message: "Companies fetched successfully",
      page,
      limit,
      total,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("❌ COMPANY GET ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET SINGLE COMPANY BY ID
========================================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id query parameter required"
      });
    }

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end,
         m.from_year,
         m.to_year
       FROM app_test.companies c
       INNER JOIN app_test.connector_machines m
           ON c.name = m.company_name
       WHERE c.id = $1 AND m.user_id = $2 AND m.tally_connected = true`,
      [id, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    return res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    console.log("❌ COMPANY GET BY ID ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET COMPANIES BY USER (SIMPLE)
========================================= */
router.get("/user/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM app_test.companies c
       INNER JOIN app_test.connector_machines m
           ON c.name = m.company_name
       WHERE m.user_id = $1
       ORDER BY c.id DESC`,
      [user_id]
    );

    return res.json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("❌ COMPANY USER ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;