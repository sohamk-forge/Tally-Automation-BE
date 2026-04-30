import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/**
 * GET /api/companies
 * Supports:
 * - search
 * - pagination
 */
router.get("/", async (req, res) => {
  try {
    const search = req.query.search || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const offset = (page - 1) * limit;

    // 🔹 Get data
    const result = await pool.query(
      `
      SELECT id, name, created_at
      FROM companies
      WHERE name ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    // 🔹 Get total count (for pagination)
    const countResult = await pool.query(
      `
      SELECT COUNT(*) FROM companies
      WHERE name ILIKE $1
      `,
      [`%${search}%`]
    );

    const total = parseInt(countResult.rows[0].count);

    res.json({
      status: "success",
      message: "Companies fetched successfully",
      page,
      limit,
      total,
      count: result.rows.length,
      data: result.rows,
    });

  } catch (err) {
    console.error("Companies Error:", err);

    res.status(500).json({
      status: "error",
      message: err.message || "Database error",
    });
  }
});

export default router;