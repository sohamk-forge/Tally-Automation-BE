import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/**
 * GET /api/ledgers
 * Read ledgers from PostgreSQL database only
 */
router.get("/", async (req, res) => {

  try {

    // Company query parameter
    const company = req.query.company;

    // Validate company
    if (!company) {

      return res.status(400).json({
        status: "error",
        message: "Company query parameter is required"
      });

    }

    // Optional search
    const search = req.query.search || "";

    // Pagination
    const page =
      parseInt(req.query.page) || 1;

    const limit =
      parseInt(req.query.limit) || 20;

    const offset =
      (page - 1) * limit;

    // Fetch ledgers
    const result = await pool.query(
      `
      SELECT

        id,

        name,

        parent_group AS under_group,

        address,

        state,

        gst_number,

        gst_type,

        pan_number,

        opening_balance,

        opening_balance_type,

        created_at

      FROM app.ledgers

      WHERE LOWER(company_name) = LOWER($1)
      AND name ILIKE $2

      ORDER BY name ASC

      LIMIT $3 OFFSET $4
      `,
      [
        company,
        `%${search}%`,
        limit,
        offset
      ]
    );

    // Total count
    const countResult = await pool.query(
      `
      SELECT COUNT(*)

      FROM app.ledgers

      WHERE company_name = $1
      AND name ILIKE $2
      `,
      [
        company,
        `%${search}%`
      ]
    );

    // Success response
    return res.json({

      status: "success",

      message:
        "Ledgers fetched successfully",

      company,

      page,

      limit,

      total:
        parseInt(
          countResult.rows[0].count
        ),

      count:
        result.rows.length,

      data:
        result.rows

    });

  } catch (err) {

    console.error(
      "Ledgers API Error:",
      err
    );

    return res.status(500).json({

      status: "error",

      message:
        err.message

    });

  }

});

export default router;