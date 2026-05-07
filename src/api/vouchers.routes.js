import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const company = req.query.company;
    
    if (!company) {
      return res.status(400).json({ message: "Company required" });
    }

    const search = req.query.search || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `
      SELECT id, voucher_number, voucher_type, voucher_date, created_at
      FROM app.vouchers
      WHERE voucher_number ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM app.vouchers WHERE voucher_number ILIKE $1`,
      [`%${search}%`]
    );

    res.json({
      status: "success",
      page,
      limit,
      total: parseInt(countResult.rows[0].count),
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;