import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* =========================================
   ALL LEDGER DETAILS DB API
========================================= */

router.get("/", async (req, res) => {

  try {

    /* =========================================
       QUERY PARAM
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
        SELECT *

        FROM app_test.all_ledger_details

        WHERE LOWER(company_name)
        = LOWER($1)

        ORDER BY ledger_name ASC
        `,

        [company]

      );

    /* =========================================
       NO DATA
    ========================================= */

    if (!result.rows.length) {

      return res.status(404).json({

        status: "error",

        source: "database",

        company,

        message:
          "No ledger details found",

        data: []

      });

    }

    /* =========================================
       SUCCESS
    ========================================= */

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
      "❌ ALL LEDGER DETAILS DB ERROR:",
      err.message
    );

    return res.status(500).json({

      status: "error",

      message:
        err.message

    });

  }

});

export default router;