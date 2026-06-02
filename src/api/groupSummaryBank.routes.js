import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.get("/", async (req, res) => {

  try {

    const { company_id } = req.query;

    if (!company_id) {
      return res.status(400).json({
        status: "error",
        message: "company_id is required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.bank_accounts
      WHERE company_id = $1
      ORDER BY ledger_name ASC
      `,
      [company_id]
    );

    return res.status(200).json({
      status: "success",
      source: "database",
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {

    console.log(
      "❌ GROUP SUMMARY BANK DB ERROR:",
      err.message
    );

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

export default router;