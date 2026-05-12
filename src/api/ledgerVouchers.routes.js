import express from "express";

import { sendToTally }
from "../services/tallyClient.js";

import pool
from "../db/index.js";

import {
  getLedgerVouchersXML
}
from "../services/xmlBuilder.js";

import {
  parseXML
}
from "../services/parser.js";

const router =
  express.Router();

/* ===================================================
   LEDGER VOUCHERS
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
         XML
      ========================================= */

      const xml =
        getLedgerVouchersXML(
          company,
          fromDate,
          toDate
        );

      /* =========================================
         SEND TO TALLY
      ========================================= */

      const responseXML =
        await sendToTally(xml);

      /* =========================================
         PARSE XML
      ========================================= */

      const parsed =
        parseXML(responseXML);

      /* =========================================
         COLLECTION
      ========================================= */

      const collection =
        parsed?.ENVELOPE?.BODY?.DATA
          ?.COLLECTION?.VOUCHER || [];

      const list =
        Array.isArray(collection)
          ? collection
          : [collection];

      /* =========================================
         CLEAN FUNCTION
      ========================================= */

      const clean = (value) => {

        if (
          value === null ||
          value === undefined
        ) {

          return null;

        }

        return String(value)

          .replace(
            /&#13;&#10;|\r|\n/g,
            ""
          )

          .trim();

      };

      /* =========================================
         DEEP CLEAN FUNCTION
      ========================================= */

      const deepClean = (obj) => {

        if (
          typeof obj === "string"
        ) {

          return obj

            .replace(
              /&#13;&#10;|\r|\n/g,
              ""
            )

            .trim();

        }

        if (
          Array.isArray(obj)
        ) {

          return obj.map(
            deepClean
          );

        }

        if (
          obj &&
          typeof obj === "object"
        ) {

          const cleaned = {};

          for (const key in obj) {

            cleaned[key] =
              deepClean(
                obj[key]
              );

          }

          return cleaned;

        }

        return obj;

      };

      /* =========================================
         FINAL DATA
      ========================================= */

      const data =

        list

          .map((voucher) => ({

            company_name:
              company,

            date:

              clean(
                voucher?.DATE
              )?.replace(

                /(\d{4})(\d{2})(\d{2})/,

                "$1-$2-$3"
              ),

            voucher_type:

              clean(
                voucher?.VOUCHERTYPENAME
              ),

            voucher_number:

              clean(
                voucher?.VOUCHERNUMBER
              ),

            party_ledger_name:

              clean(
                voucher?.PARTYLEDGERNAME
              ),

            narration:

              clean(
                voucher?.NARRATION
              ),

            ledger_entries:

              (() => {

                const entries =

                  voucher?.[
                    "ALLLEDGERENTRIES.LIST"
                  ];

                const normalized =

                  Array.isArray(entries)

                    ? entries

                    : entries

                    ? [entries]

                    : [];

                return deepClean(
                  normalized
                );

              })()

          }))

          .filter(
            (voucher) =>
              voucher.voucher_number
          );

      /* =========================================
         FILTERS
      ========================================= */

      let filteredData =
        data;

      /* ---- Voucher Type Filter ---- */

      if (voucherType) {

        filteredData =

          filteredData.filter(
            (voucher) =>

              voucher
                .voucher_type

                ?.toLowerCase()

                .includes(

                  voucherType
                    .toLowerCase()

                )
          );

      }

      /* ---- Party Filter ---- */

      if (party) {

        filteredData =

          filteredData.filter(
            (voucher) =>

              voucher
                .party_ledger_name

                ?.toLowerCase()

                .includes(

                  party
                    .toLowerCase()

                )
          );

      }

      /* =========================================
         STORE IN DATABASE
      ========================================= */

      for (const voucher of filteredData) {

        await pool.query(

          `
          INSERT INTO app.vouchers (

            company_name,
            voucher_date,
            voucher_type,
            voucher_number,
            party_ledger_name,
            narration

          )

          SELECT

            $1,
            $2,
            $3,
            $4,
            $5,
            $6

          WHERE NOT EXISTS (

            SELECT 1
            FROM app.vouchers

            WHERE

              company_name = $1
              AND voucher_type = $3
              AND voucher_number = $4

          )
          `,

          [

            voucher.company_name,

            voucher.date,

            voucher.voucher_type,

            voucher.voucher_number,

            voucher.party_ledger_name,

            voucher.narration

          ]

        );

      }

      /* =========================================
         SUCCESS RESPONSE
      ========================================= */

      return res.status(200).json({

        status: "success",

        source: "tally",

        company,

        fromDate,

        toDate,

        total:
          filteredData.length,

        data:
          filteredData

      });

    } catch (err) {

      console.log(

        "❌ LEDGER VOUCHER ERROR:",

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