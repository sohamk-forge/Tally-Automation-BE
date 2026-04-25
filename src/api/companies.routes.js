import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* GET Companies From PostgreSQL */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, created_at
      FROM companies
      ORDER BY created_at DESC
    `);

    res.json({
      status: "success",
      message: "Companies fetched successfully",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("Companies Error:", err);

    res.status(500).json({
      status: "error",
      message: err.message || "Database error"
    });
  }
});

export default router;