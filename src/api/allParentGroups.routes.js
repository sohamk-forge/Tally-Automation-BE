import express from "express";

import pool from "../db/index.js";

const router =
  express.Router();

/* ===================================================
   ALL PARENT GROUPS DB API
===================================================

API:

GET /api/all-parent-groups

Example:

/api/all-parent-groups?
company=Nutan Dairy&
groupName=Sales Accounts

=================================================== */

router.get(
  "/",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const company =
        req.query.company;

      const groupName =
        req.query.groupName;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company query parameter required"

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

      const result =

        await pool.query(

          `
          SELECT

            id,

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

          FROM app.all_parent_groups

          WHERE LOWER(company_name)
          = LOWER($1)

          AND LOWER(parent_group)
          = LOWER($2)

          ORDER BY ledger_name ASC
          `,

          [
            company,
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

          company,

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

        company,

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