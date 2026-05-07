import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/**
 * GET /api/companies
 * Returns:
 * id + name + financial year only
 */
router.get("/", async (req, res) => {
  try {
    let search = (req.query.search || "").trim();

    let page = parseInt(req.query.page);
    let limit = parseInt(req.query.limit);

    // Validation
    page = isNaN(page) || page < 1 ? 1 : page;
    limit = isNaN(limit) || limit < 1 ? 10 : limit;

    // Max limit protection
    if (limit > 100) limit = 100;

    const offset = (page - 1) * limit;

    // 🔥 FIXED: Convert INTEGER to TEXT then use LEFT() for first 4 digits
    const result = await pool.query(
      `
      SELECT 
        id,
        name,

        CASE
          WHEN financial_year_start IS NOT NULL
          THEN LEFT(financial_year_start::TEXT, 4)
          ELSE NULL
        END AS financial_year_start,

        CASE
          WHEN financial_year_end IS NOT NULL
          THEN LEFT(financial_year_end::TEXT, 4)
          ELSE NULL
        END AS financial_year_end,

        CONCAT(
          CASE
            WHEN financial_year_start IS NOT NULL
            THEN LEFT(financial_year_start::TEXT, 4)
            ELSE NULL
          END,
          '-',
          CASE
            WHEN financial_year_end IS NOT NULL
            THEN LEFT(financial_year_end::TEXT, 4)
            ELSE NULL
          END
        ) AS financial_year

      FROM app.companies

      WHERE name ILIKE $1

      ORDER BY name ASC

      LIMIT $2 OFFSET $3
      `,
      [`%${search}%`, limit, offset]
    );

    // Total count
    const countResult = await pool.query(
      `
      SELECT COUNT(*)
      FROM app.companies
      WHERE name ILIKE $1
      `,
      [`%${search}%`]
    );

    const total = parseInt(countResult.rows[0].count);

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
    console.error("Companies Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message || "Database error"
    });
  }
});

/**
 * GET /api/companies/:id
 * Get single company by ID with full details
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT 
        id, 
        name,
        under_group,
        address,
        state,
        gst_number,
        gst_type,
        pan_number,
        phone,
        email,
        website,
        opening_balance,
        opening_balance_type,
        financial_year_start,
        financial_year_end,
        LEFT(financial_year_start::TEXT, 4) AS financial_year_start_str,
        LEFT(financial_year_end::TEXT, 4) AS financial_year_end_str,
        CONCAT(
          LEFT(financial_year_start::TEXT, 4),
          '-',
          LEFT(financial_year_end::TEXT, 4)
        ) AS financial_year,
        created_at,
        updated_at
      FROM app.companies
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Company Error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;