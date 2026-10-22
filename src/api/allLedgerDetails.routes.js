import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   ALL LEDGER DETAILS DB API
========================================= */

router.get("/", async (req, res) => {

  try {

    const companyId = Number(req.query.company_id);

    if (!companyId || isNaN(companyId)) {

      return res.status(400).json({

        status: "error",

        message:
          "Valid company_id query parameter required"

      });

    }

    // Only the columns the ledger list page (Ledger.jsx) actually renders —
    // SELECT * was shipping every column (address, guid, master_id, alter_id,
    // timestamps, ...) for every ledger on every load/poll.
    const result = await pool.query(

      `
      SELECT
        l.ledger_name,
        l.parent_group,
        l.primary_group,
        l.gst_number,
        l.state,
        l.opening_balance,
        l.closing_balance,
        l.address,
        l.primary_phone_number,
        l.email,
        l.pan_number,
        l.gst_registration_type,
        COALESCE(t.txn_count, 0) AS txn_count

      FROM ${DB_SCHEMA}.all_ledger_details l

      -- Vouchers touching each ledger (as party or any ledger leg), the same match
      -- LedgerDetail uses, so the list count equals the rows shown on the detail page.
      LEFT JOIN (
        SELECT x.k, COUNT(DISTINCT x.id)::int AS txn_count
        FROM (
          SELECT v.id, LOWER(TRIM(v.party_ledger_name)) AS k
          FROM ${DB_SCHEMA}.vouchers v
          WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.is_optional IS NOT TRUE
          UNION ALL
          SELECT v.id, LOWER(TRIM(e->>'LEDGERNAME'))
          FROM ${DB_SCHEMA}.vouchers v
          CROSS JOIN LATERAL jsonb_array_elements(v.ledger_entries) e
          WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.is_optional IS NOT TRUE
            AND jsonb_typeof(v.ledger_entries) = 'array'
        ) x
        WHERE x.k IS NOT NULL
        GROUP BY x.k
      ) t ON t.k = LOWER(TRIM(l.ledger_name))

      WHERE l.company_id = $1 AND l.deleted_at IS NULL

      ORDER BY l.ledger_name ASC
      `,

      [companyId]

    );

    if (!result.rows.length) {

      return res.status(404).json({

        status: "error",

        source: "database",

        company_id: companyId,

        message:
          "No ledger details found",

        data: []

      });

    }

    return res.status(200).json({

      status: "success",

      source: "database",

      company_id: companyId,

      total: result.rows.length,

      data: result.rows

    });

  } catch (err) {

    console.log(
      "❌ ALL LEDGER DETAILS DB ERROR:",
      err.message
    );

    return res.status(500).json({

      status: "error",

      message: err.message

    });

  }

});

export default router;