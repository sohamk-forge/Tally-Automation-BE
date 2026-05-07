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
    let search = (req.query.search || "").trim();

    let page = parseInt(req.query.page);
    let limit = parseInt(req.query.limit);

    // ✅ defaults + validation
    page = isNaN(page) || page < 1 ? 1 : page;
    limit = isNaN(limit) || limit < 1 ? 10 : limit;

    // ✅ max limit protection
    if (limit > 100) limit = 100;

    const offset = (page - 1) * limit;

    // 🔹 Fetch data
    const result = await pool.query(
      `
      SELECT id, name, created_at
      FROM app.companies
      WHERE name ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    // 🔹 Total count
    const countResult = await pool.query(
      `
      SELECT COUNT(*) FROM app.companies
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