import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   ALL PARENT GROUPS DB API
===================================================

API:

GET /api/all-parent-groups

Example:

/api/all-parent-groups?
company_id=1&
groupName=Sales Accounts

=================================================== */

router.get(

  "/",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const companyId =
        req.query.company_id;

      const groupName =
        req.query.groupName;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!companyId) {

        return res.status(400).json({

          status: "error",

          message:
            "company_id query parameter required"

        });

      }

      if (!groupName) {

        return res.status(400).json({

          status: "error",

          message:
            "groupName query parameter required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result = await pool.query(

        `
        SELECT

          id,

          company_id,

          company_name,

          ledger_name,

          parent_group,

          address,

          state,

          country,

          pincode,

          pan_number,

          gst_number,

          gst_registration_type,

          contact_name,

          phone_number,

          primary_phone_number,

          fax_no,

          email,

          opening_balance,

          closing_balance,

          opening_balance_type,

          closing_balance_type,

          created_at,

          updated_at

       FROM ${DB_SCHEMA}.all_parent_groups

        WHERE company_id = $1

        AND LOWER(parent_group)
        = LOWER($2)

        ORDER BY ledger_name ASC
        `,

        [
          companyId,
          groupName
        ]

      );

      /* =========================================
         NO DATA
      ========================================= */

      if (!result.rows.length) {

        return res.status(404).json({

          status: "error",

          source: "database",

          message:
            "No records found",

          company_id:
            companyId,

          parent_group:
            groupName,

          total: 0,

          data: []

        });

      }

      /* =========================================
         SUCCESS RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company_id:
          companyId,

        parent_group:
          groupName,

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(

        "❌ ALL PARENT GROUP DB ERROR:",

        err.message

      );

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;