import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* ==================================================
   GET LEDGERS
==================================================

API:
GET /api/ledgers

Query Params:

company = Company Name (required)

search = Ledger search (optional)

page = Page number (optional)

limit = Records per page (optional)

Example:

/api/ledgers?
company=Venkateshwara Traders

================================================== */

router.get("/", async (req, res) => {

  try {

    /* =========================================
       QUERY PARAMETERS
    ========================================= */

    const {

      company,

      search = "",

      page = 1,

      limit = 20

    } = req.query;

    /* =========================================
       VALIDATION
    ========================================= */

    if (!company) {

      return res.status(400).json({

        status: "error",

        message:
          "company query parameter is required"

      });

    }

    /* =========================================
       PAGINATION
    ========================================= */

    const pageNumber =
      Math.max(
        parseInt(page) || 1,
        1
      );

    const limitNumber =
      Math.max(
        parseInt(limit) || 20,
        1
      );

    const offset =
      (pageNumber - 1) * limitNumber;

    /* =========================================
       MAIN QUERY
    ========================================= */

    const ledgerQuery = `

    SELECT

  id,

  company_id,

  company_name,

  name,

  gst_number,

  guid,

  created_at,

  updated_at
    FROM app_test.ledgers

      WHERE

        LOWER(company_name)
        =
        LOWER($1)

      AND

        name ILIKE $2

      ORDER BY

        name ASC

      LIMIT $3

      OFFSET $4

    `;

    const ledgerValues = [

      company,

      `%${search}%`,

      limitNumber,

      offset

    ];

    const result =
      await pool.query(
        ledgerQuery,
        ledgerValues
      );

    /* =========================================
       TOTAL COUNT
    ========================================= */

    const countQuery = `

      SELECT COUNT(*) AS total

    FROM app_test.ledgers

      WHERE

        LOWER(company_name)
        =
        LOWER($1)

      AND

        name ILIKE $2

    `;

    const countResult =
      await pool.query(
        countQuery,
        [
          company,
          `%${search}%`
        ]
      );

    const total =
      parseInt(
        countResult.rows[0].total
      );

    /* =========================================
       EMPTY RESPONSE
    ========================================= */

    if (!result.rows.length) {

      return res.status(200).json({

        status: "success",

        message:
          "No ledgers found",

        company,

        search,

        page:
          pageNumber,

        limit:
          limitNumber,

        total: 0,

        count: 0,

        total_pages: 0,

        data: []

      });

    }

    /* =========================================
       SUCCESS RESPONSE
    ========================================= */

    return res.status(200).json({

      status: "success",

      message:
        "Ledgers fetched successfully",

      company,

      search,

      page:
        pageNumber,

      limit:
        limitNumber,

      total,

      count:
        result.rows.length,

      total_pages:
        Math.ceil(
          total / limitNumber
        ),

      data:
        result.rows

    });

  } catch (err) {

    console.error(
      "❌ Ledger API Error:",
      err.message
    );

    return res.status(500).json({

      status: "error",

      message:
        "Internal Server Error",

      error:
        err.message

    });

  }

});

export default router;