import express from "express";
import pool from "../db/index.js";

const router = express.Router();

// GET /api/products
router.get("/", async (req, res) => {
  try {
    const search = req.query.search || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const offset = (page - 1) * limit;

    const result = await pool.query(
      `
      SELECT id, name, created_at
      FROM products
      WHERE name ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    // ✅ CLEAN DATA (important)
    const cleanData = result.rows.map((item) => ({
      ...item,
      name: item.name.replace(/&#13;&#10;|\r|\n/g, "").trim(),
    }));

    res.json({
      status: "success",
      page,
      limit,
      count: cleanData.length,
      data: cleanData,
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;