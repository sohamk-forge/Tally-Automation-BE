import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/**
 * GET /api/products
 * Supports:
 * - search
 * - pagination
 */
router.get("/", async (req, res) => {
  try {
    let search = (req.query.search || "").trim();

    let page = parseInt(req.query.page);
    let limit = parseInt(req.query.limit);

    // ✅ validation + defaults
    page = isNaN(page) || page < 1 ? 1 : page;
    limit = isNaN(limit) || limit < 1 ? 20 : limit;

    // ✅ prevent overload
    if (limit > 100) limit = 100;

    const offset = (page - 1) * limit;

    // 🔹 Fetch data
    const result = await pool.query(
      `
      SELECT id, name, created_at
      FROM app.stock_items
      WHERE name ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    // 🔹 Clean data (IMPORTANT)
    const cleanData = result.rows.map((item) => ({
      ...item,
      name: item.name
        ?.replace(/&#13;&#10;|\r|\n/g, "")
        .trim(),
    }));

    // 🔹 Total count (for pagination)
    const countResult = await pool.query(
      `
      SELECT COUNT(*) FROM app.stock_items
      WHERE name ILIKE $1
      `,
      [`%${search}%`]
    );

    const total = parseInt(countResult.rows[0].count);

    // 🔹 Response
    res.json({
      status: "success",
      message: "Products fetched successfully",
      page,
      limit,
      total,
      count: cleanData.length,
      data: cleanData,
    });

  } catch (err) {
    console.error("❌ Products API Error:", err);

    res.status(500).json({
      status: "error",
      message: err.message || "Internal server error",
    });
  }
});

export default router;