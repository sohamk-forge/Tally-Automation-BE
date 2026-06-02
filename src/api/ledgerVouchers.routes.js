import express from "express";

import pool from "../db/index.js";

const router =
  express.Router();

/* ===================================================
   LEDGER VOUCHERS DB API
===================================================

API:
GET /api/ledger-vouchers

Example:

/api/ledger-vouchers
?company=Venkateshwara Traders
&fromDate=2020-04-01
&toDate=2021-03-31

=================================================== */

router.get(

  "/ledger-vouchers",

  async (req, res) => {

    try {

      /* =========================================
         QUERY PARAMS
      ========================================= */

      const company =
        req.query.company;

      const fromDate =
        req.query.fromDate;

      const toDate =
        req.query.toDate;

      const voucherType =
        req.query.voucherType;

      const party =
        req.query.party;

      /* =========================================
         VALIDATION
      ========================================= */

      if (

        !company ||

        !fromDate ||

        !toDate

      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, fromDate and toDate required"

        });

      }

      /* =========================================
         BASE QUERY
      ========================================= */

      let query =

        `
        SELECT

          id,
          company_name,
          voucher_date,
          voucher_type,
          voucher_number,
          party_ledger_name,
          narration,
          debit_amount,
          credit_amount,
          balance,
          created_at,
          updated_at

    FROM app_test.vouchers

      WHERE

  LOWER(TRIM(company_name))
  = LOWER(TRIM($1))

  AND DATE(voucher_date)
  BETWEEN $2 AND $3
        `;

      /* =========================================
         VALUES ARRAY
      ========================================= */

      const values = [

        company,
        fromDate,
        toDate

      ];

      let paramIndex = 4;

      /* =========================================
         VOUCHER TYPE FILTER
      ========================================= */

      if (voucherType) {

        query +=

          `
          AND LOWER(voucher_type)
          LIKE LOWER($${paramIndex})
          `;

        values.push(
          `%${voucherType}%`
        );

        paramIndex++;

      }

      /* =========================================
         PARTY FILTER
      ========================================= */

    if (
  party &&
  party !== "undefined" &&
  party !== "null"
) {

        query +=

          `
          AND LOWER(party_ledger_name)
          LIKE LOWER($${paramIndex})
          `;

        values.push(
          `%${party}%`
        );

        paramIndex++;

      }

      /* =========================================
         ORDER BY
      ========================================= */

      query +=

        `
        ORDER BY
        voucher_date DESC,
        id DESC
        `;

      /* =========================================
         EXECUTE QUERY
      ========================================= */
      console.log("REQ QUERY:", req.query);
console.log("VALUES:", values);

      const result =

        await pool.query(

          query,
          values

        );

        console.log(
  "ROWS FOUND:",
  result.rows.length
);

      /* =========================================
         SUCCESS RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "database",

        company,

        fromDate,

        toDate,

        total:
          result.rows.length,

        data:
          result.rows

      });

    } catch (err) {

      console.log(

        "❌ LEDGER VOUCHER DB ERROR:",

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