import express from "express";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  getGroupSummaryBankXML
} from "../services/xmlBuilder.js";

import {
  parseXML
} from "../services/parser.js";

const router = express.Router();

/* ===================================================
   GROUP SUMMARY BANK API
===================================================

API:
GET /api/group-summary-bank

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
        getGroupSummaryBankXML(
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

    ledger?.MAILINGNAME ||

    ledger?.["LANGUAGENAME.LIST"]
      ?.["NAME.LIST"]
      ?.NAME

  ),
          parent_group:
            "Bank Accounts",
account_holder_name:
  clean(
    ledger?.BANKACCHOLDERNAME
  ),

account_number:
  clean(
    ledger?.BANKDETAILS
  ),

         ifsc_code:
  clean(
    ledger?.IFSCODE
  ),

          swift_code:
            clean(
              ledger?.SWIFTCODE
            ),

         bank_name:
  clean(

    ledger?.BANKNAME ||

    ledger?.BankDetails

  ),

         branch:
  clean(
    ledger?.BRANCHNAME
  ),

       

          address:
            Array.isArray(
              ledger?.["ADDRESS.LIST"]?.ADDRESS
            )
              ? ledger["ADDRESS.LIST"]
                  .ADDRESS
                  .map(a => clean(a))
                  .filter(Boolean)
                  .join(", ")
                  .replace(
                    /,\s*,/g,
                    ", "
                  )
              : clean(
                  ledger?.["ADDRESS.LIST"]?.ADDRESS
                ),

          state:
            clean(
              ledger?.STATENAME ||
              ledger?.STATE ||
              ledger?.LEDSTATENAME
            ),

          country:
  clean(
    ledger?.COUNTRYNAME
  ),

          pincode:
            clean(
              ledger?.PINCODE
            ),

 gst_number: clean(
  ledger?.GSTIN ||
  ledger?.PARTYGSTIN ||
  ledger?.["LEDGERGSTREGDETAILS.LIST"]?.GSTIN ||
  ledger?.["LEDGERGSTREGDETAILS.LIST"]?.[0]?.GSTIN
)

        }));

      return res.status(200).json({

        status: "success",

        source: "tally",

        message:
          "Bank accounts fetched successfully",

        company,

        total:
          data.length,

        data

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY BANK ERROR:",
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