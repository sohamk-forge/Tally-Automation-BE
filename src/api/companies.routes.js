import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   GET ALL COMPANIES (USER-FILTERED)
========================================= */
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // TOTAL COUNT
  const totalResult = await pool.query(`
    SELECT COUNT(*)
    FROM ${DB_SCHEMA}.companies c
    INNER JOIN ${DB_SCHEMA}.connector_machines m
        ON c.name = m.company_name
    WHERE m.tally_connected = true
`);

    const total = parseInt(totalResult.rows[0].count);

    // FETCH ONLY THIS USER'S COMPANIES
    const result = await pool.query(
      `
     SELECT
    c.id,
    c.name,
    c.financial_year_start,
    c.financial_year_end,
    CONCAT(
        c.financial_year_start,
        '-',
        c.financial_year_end
    ) AS financial_year
FROM ${DB_SCHEMA}.companies c
INNER JOIN ${DB_SCHEMA}.connector_machines m
    ON c.name = m.company_name
WHERE m.tally_connected = true
ORDER BY c.id DESC
LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

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
    console.log("❌ COMPANY GET ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET SINGLE COMPANY BY ID
========================================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id query parameter required"
      });
    }

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end,
         m.from_year,
         m.to_year
       FROM app_test.companies c
       INNER JOIN app_test.connector_machines m
           ON c.name = m.company_name
       WHERE c.id = $1 AND m.user_id = $2 AND m.tally_connected = true`,
      [id, user_id]
    );

    if (!companies.length) {
      throw new Error("No companies received from Tally");
    }

    // UPSERT EACH COMPANY
    const results = [];

    for (const company of companies) {

      const rawName =
  company?.["@_NAME"] ||
  company?.NAME?.["#text"] ||
  company?.NAME ||
  null;

const rawFromDate =
  company?.BOOKSFROM?.["#text"] ||
  company?.BOOKSFROM ||
  null;

const rawToDate =
  company?.ENDINGAT?.["#text"] ||
  company?.ENDINGAT ||
  null;

      console.log("NAME =>", rawName);
      console.log("FROM =>", rawFromDate);
      console.log("TO   =>", rawToDate);

      // VALIDATION
      if (!rawName) {
        console.warn("Skipping entry — company name missing");
        continue;
      }

      // CLEAN VALUES
      // Tally dates come as YYYYMMDD — convert to YYYY-MM-DD
      const name = String(rawName).trim();

     const financial_year_start =
  rawFromDate
    ? parseInt(
        String(rawFromDate).substring(0, 4)
      )
    : null;

const financial_year_end =
  rawToDate
    ? parseInt(
        String(rawToDate).substring(0, 4)
      )
    : null;

      // INSERT / UPDATE DATABASE
      const result = await pool.query(
        `
       INSERT INTO ${DB_SCHEMA}.companies (

          name,
          financial_year_start,
          financial_year_end,
          created_at,
          updated_at

        )

        VALUES (

          $1,
          $2,
          $3,
          NOW(),
          NOW()

        )

        ON CONFLICT (name)

        DO UPDATE SET

          financial_year_start =
            EXCLUDED.financial_year_start,

          financial_year_end =
            EXCLUDED.financial_year_end,

          updated_at = NOW()

        RETURNING id
        `,
        [
          name,
          financial_year_start,
          financial_year_end
        ]
      );

      results.push({
        id: result.rows[0]?.id,
        name,
        financial_year_start,
        financial_year_end
      });
    }

    // SUCCESS RESPONSE
    return res.json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("❌ COMPANY USER ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;