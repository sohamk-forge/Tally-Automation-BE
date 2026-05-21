import express from "express";

import pool
from "../db/index.js";

const router =
  express.Router();

/* ===================================================
   PAYABLE + RECEIVABLE DB API
=================================================== */

router.get(

  "/payable-debtors",

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
            "company query parameter required"

        });

      }

      /* =========================================
         DATABASE QUERY
      ========================================= */

      const result =

        await pool.query(

          `
          SELECT

            company_name,
            group_name,
            parent_group,
            opening_balance,
            closing_balance

          FROM app.group_balances

          WHERE company_name = $1
          `,

          [company]

        );

      /* =========================================
         DEBTORS
      ========================================= */

      const debtors =

        result.rows.find(

          (row) =>

            row.group_name ===
            "Sundry Debtors"

        );

      /* =========================================
         CREDITORS
      ========================================= */

      const creditors =

        result.rows.find(

          (row) =>

            row.group_name ===
            "Sundry Creditors"

        );

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        data: {

          debtors,

          creditors

        }

      });

    } catch (err) {

      console.log(

        "❌ GROUP BALANCE DB ERROR:",

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