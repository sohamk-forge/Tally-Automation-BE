import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* ===================================================
   UNITS DB API
===================================================

API:
GET /api/units?company_id=1

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

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =

        await pool.query(

          `
          SELECT

            id,

            company_id,

            company_name,

            unit_name,

            created_at,

            updated_at

          FROM ${DB_SCHEMA}.units

          WHERE company_id = $1

          ORDER BY unit_name
          `,

          [companyId]

        );

      /* =========================================
         NO DATA
      ========================================= */

      if (!result.rows.length) {

        return res.status(404).json({

          status: "error",

          source: "database",

          message:
            "No units found",

          company_id:
            companyId,

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

        count:
          result.rows.length,

        data:

          result.rows.map((row) => ({

            id:
              Number(row.id),

            company_id:
              Number(row.company_id),

            company_name:
              row.company_name,

            unit_name:
              row.unit_name,

            created_at:
              row.created_at,

            updated_at:
              row.updated_at

          }))

      });

    } catch (err) {

      console.log(

        "❌ UNITS DB ERROR:",

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