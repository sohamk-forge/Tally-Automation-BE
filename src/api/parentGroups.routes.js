import express from "express";

import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   PARENT GROUPS DB API
===================================================

API:
GET /api/parent-groups

=================================================== */

router.get(
  "/parent-groups",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const company =
        req.query.company;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =
        await pool.query(

          `
          SELECT group_name

        FROM app_test.parent_groups

          WHERE company_name = $1

          ORDER BY group_name ASC
          `,

          [company]

        );

      /* =========================================
         PARENT GROUPS ARRAY
      ========================================= */

      const parentGroups =

        result.rows.map(

          (row) => row.group_name

        );

      /* =========================================
         SUCCESS RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        total:
          parentGroups.length,

        parent_groups:
          parentGroups

      });

    } catch (err) {

      console.log(

        "❌ PARENT GROUP DB ERROR:",

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