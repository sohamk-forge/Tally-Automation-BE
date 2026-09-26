import express from "express";

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { resolveOwnedCompanyByName } from "../middleware/companyAccess.middleware.js";
const router = express.Router();

/* ===================================================
   SALES ITEMS DB API
===================================================

API:
GET /api/sales-items

Example:

/api/sales-items
?company=Nutan Dairy

=================================================== */

router.get(

  "/sales-items",

  async (req, res) => {

    try {

      const company =
        req.query.company;

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company required"

        });

      }

      // company_name alone matches every tenant with that name — scope to
      // the caller's own company id (legacy rows without company_id still
      // match by name).
      const companyId =
        await resolveOwnedCompanyByName(req, company);

      if (!companyId) {

        return res.status(404).json({

          status: "error",

          message:
            "Company not found"

        });

      }

      const result =

        await pool.query(

          `
          SELECT

            id,

            company_name,

            description,

            actual_quantity,

            billed_quantity,

            billing,

            total_amount,

            created_at

        FROM ${DB_SCHEMA}.sales_items

          WHERE (
            company_id = $2
            OR (company_id IS NULL AND company_name = $1)
          )

          ORDER BY id DESC
          `,

          [company, companyId]

        );

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(

        "❌ SALES ITEMS ERROR:",

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