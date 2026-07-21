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

    const result = await pool.query(

      `
      SELECT *

      FROM ${DB_SCHEMA}.all_ledger_details

      WHERE company_id = $1

      ORDER BY ledger_name ASC
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