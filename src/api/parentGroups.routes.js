import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* ===================================================
   PARENT GROUPS DB API
===================================================

API:
GET /api/parent-groups?company_id=1

=================================================== */

router.get(
  "/parent-groups",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const companyId =
        req.query.company_id;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!companyId) {

        return res.status(400).json({

          status: "error",

          message:
            "company_id required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =
        await pool.query(

          `
          SELECT
            group_name

          FROM app_test.parent_groups

          WHERE company_id = $1

          ORDER BY group_name ASC
          `,

          [companyId]

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

        company_id:
          companyId,

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