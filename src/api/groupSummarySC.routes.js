import express from "express";

import pool from "../db/index.js";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  getGroupSummaryCRXML
} from "../services/xmlBuilder.js";

import {
  parseXML
} from "../services/parser.js";

const router = express.Router();

/* ===================================================
   GROUP SUMMARY SC API
===================================================

API:
GET /api/group-summary/sc/sundry-creditors

=================================================== */

router.get(
  "/",
  async (req, res) => {

    try {

      const company =
        req.query.company;

      if (!company) {

        return res.status(400).json({

          status: "error",

          message:
            "company query parameter required"

        });

      }

      /* =========================================
         GET XML
      ========================================= */

      const xml =
        getGroupSummaryCRXML(
          company
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

      const collection =
        parsed?.ENVELOPE?.BODY?.DATA
          ?.COLLECTION?.LEDGER || [];

      const list =
        Array.isArray(collection)
          ? collection
          : [collection];

      /* =========================================
         CLEAN FUNCTION
      ========================================= */

const clean = (value) => {

  if (!value) return null;

  return String(value)

    .replace(
      /&#13;&#10;|\r|\n/g,
      ""
    )

    .replace(/,+/g, ",")

    .replace(/\s+,/g, ",")

    .replace(/�/g, "")

    .trim();

};

const cleanBalance = (value) => {

  if (!value) return null;

  const matches =
    String(value).match(
      /-?\d+(\.\d+)?/g
    );

  if (!matches) return null;

  return matches[
    matches.length - 1
  ];

};
const getBalanceType = (value) => {

  const amount =
    cleanBalance(value);

  if (!amount)
    return "Dr";

  return String(amount)
    .startsWith("-")
      ? "Cr"
      : "Dr";

};
      /* =========================================
         FINAL RESPONSE
      ========================================= */

      const data =
        list.map((ledger) => ({

          company_name:
            company,

         ledger_name:
  clean(
    ledger?.$?.NAME ||
    ledger?.["@NAME"] ||
    ledger?.NAME ||
    ledger?.MAILINGNAME
  ),
          parent_group:
            "Sundry Creditors",

         address:
  Array.isArray(
    ledger?.["ADDRESS.LIST"]?.ADDRESS
  )
    ? ledger["ADDRESS.LIST"]
        .ADDRESS
        .map(a => clean(a))
        .filter(Boolean)
        .join(", ")
        .replace(/,+/g, ",")
        .replace(/\s+,/g, ",")
    : clean(
        ledger?.["ADDRESS.LIST"]?.ADDRESS
      ),

          alias:
            clean(
              ledger?.ALIAS
            ),

          state:
            clean(
              ledger?.STATENAME ||
              ledger?.STATE ||
              ledger?.LEDSTATENAME
            ),

          country:
            clean(
              ledger?.COUNTRYNAME ||
              ledger?.LEDCOUNTRYNAME
            ),

          pincode:
            clean(
              ledger?.PINCODE
            ),

          pan_number:
            clean(
              ledger?.INCOMETAXNUMBER
            ),

          gst_number:
            clean(
              ledger?.PARTYGSTIN
            ),

          gst_registration_type:
            clean(
              ledger?.GSTREGISTRATIONTYPE
            ),

          contact_name:
            clean(
              ledger?.CONTACTPERSON
            ),

          phone_number:
            clean(
              ledger?.PHONE ||
              ledger?.LEDGERPHONE
            ),

          primary_phone_number:
            clean(
              ledger?.MOBILE ||
              ledger?.LEDGERMOBILE
            ),

          fax_no:
            clean(
              ledger?.FAX
            ),

          email:
            clean(
              ledger?.EMAIL ||
              ledger?.LEDGEREMAIL
            ),

          opening_balance:
  cleanBalance(
    ledger?.OPENINGBALANCE
  ),

          closing_balance:
  cleanBalance(
    ledger?.CLOSINGBALANCE
  ),

          opening_balance_type:
  getBalanceType(
    ledger?.OPENINGBALANCE
  ),

          closing_balance_type:
  getBalanceType(
    ledger?.CLOSINGBALANCE
  ),

        }));

      /* =========================================
         SAVE INTO DATABASE
      ========================================= */

      for (const item of data) {

        await pool.query(
          `
          INSERT INTO
          app.sundry_creditors (

            company_name,
            ledger_name,
            parent_group,
            address,
            alias,
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
            closing_balance_type

          )

          VALUES (

            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,
            $16,$17,$18,$19,$20

          )
          `,
          [

            item.company_name,
            item.ledger_name,
            item.parent_group,
            item.address,
            item.alias,
            item.state,
            item.country,
            item.pincode,
            item.pan_number,
            item.gst_number,
            item.gst_registration_type,
            item.contact_name,
            item.phone_number,
            item.primary_phone_number,
            item.fax_no,
            item.email,
            item.opening_balance,
            item.closing_balance,
            item.opening_balance_type,
            item.closing_balance_type

          ]
        );

      }

      return res.status(200).json({

        status: "success",

        source: "tally",

        message:
          "Sundry creditors fetched successfully and saved into database",

        company,

        total:
          data.length,

        data

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY SC ERROR:",
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