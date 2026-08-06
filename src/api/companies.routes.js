import express from "express";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   SCOPING NOTE

   companies is a shared table with no owner column. Authorization comes from
   connector_pairing_tokens (user_id + company_id): a user may see a company
   only if THEY have a used pairing token for it.

   Previously these endpoints joined connector_machines on
   c.name = m.company_name with no user filter at all, so every user saw every
   connected company - a brand new account saw the full list on first login.

   Why pairing tokens and not connector_machines:
     - connector_machines is not reliably populated (user 29 has completed jobs
       all day but no machine row), so scoping on it would hide companies from
       legitimate users.
     - Joining on company_id avoids the c.name = m.company_name string match,
       which this project has already been bitten by via company-name truncation.

   connector_machines is still LEFT JOINed, but only to supply display fields
   (from_year, to_year, tally_connected). A missing machine row leaves those
   null instead of hiding the company.

   DISTINCT is required: a user typically has many pairing tokens for the same
   company (company 1 has dozens), which would otherwise duplicate every row
   and break the pagination count.
========================================= */

/* =========================================
   GET ALL COMPANIES (paginated, current user only)
========================================= */
router.get("/", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // COUNT TOTAL
    const totalResult = await pool.query(
      `SELECT COUNT(DISTINCT c.id)
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE`,
      [userId]
    );

    const total = parseInt(totalResult.rows[0].count);

    // FETCH COMPANIES
    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE
       ORDER BY c.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
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
    console.log("COMPANY GET ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET SINGLE COMPANY BY ID (current user only)
   Without the user filter any caller could read any company by guessing
   an integer id.
========================================= */
router.get("/:id", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const { id } = req.params;

    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE c.id = $1
         AND cpt.user_id = $2
         AND cpt.is_used = TRUE`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    return res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    console.log("COMPANY GET BY ID ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET ALL COMPANIES (SIMPLE, current user only)
========================================= */
router.get("/all/list", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const result = await pool.query(
      `SELECT DISTINCT
         c.id,
         c.name,
         c.financial_year_start,
         c.financial_year_end,
         m.from_year,
         m.to_year,
         m.tally_connected
       FROM ${DB_SCHEMA}.companies c
       INNER JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
           ON c.id = cpt.company_id
       LEFT JOIN ${DB_SCHEMA}.connector_machines m
           ON m.company_name = c.name
          AND m.user_id = cpt.user_id
       WHERE cpt.user_id = $1
         AND cpt.is_used = TRUE
       ORDER BY c.id DESC`,
      [userId]
    );

    return res.json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.log("COMPANY LIST ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
  
export default router;