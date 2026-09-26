import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ==================================================
   GET LEDGERS
==================================================

API:
GET /api/ledgers

Query Params:

company_id = Company ID (required)

search = Ledger search (optional)

page = Page number (optional)

limit = Records per page (optional)

Example:

/api/ledgers?
company_id=1

================================================== */

router.get("/", async (req, res) => {

  try {

    /* =========================================
       QUERY PARAMETERS
    ========================================= */

    const {

      company_id,

      search = "",

      page = 1,

      limit = 20

    } = req.query;

    /* =========================================
       VALIDATION
    ========================================= */

    if (!company_id) {

      return res.status(400).json({

        status: "error",

        message:
          "company_id query parameter is required"

      });

    }

    /* =========================================
       PAGINATION
    ========================================= */

    const pageNumber =
      Math.max(
        Number(page) || 1,
        1
      );

    const limitNumber =
      Math.max(
        Number(limit) || 20,
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

      FROM ${DB_SCHEMA}.ledgers

      WHERE

        company_id = $1

      AND

        name ILIKE $2

      ORDER BY

        name ASC

      LIMIT $3

      OFFSET $4

    `;

    const ledgerValues = [

      company_id,

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

      FROM ${DB_SCHEMA}.ledgers

      WHERE

        company_id = $1

      AND

        name ILIKE $2

    `;

    const countResult =
      await pool.query(
        countQuery,
        [
          company_id,
          `%${search}%`
        ]
      );

    const total =
      Number(
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

        company_id,

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

      company_id,

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