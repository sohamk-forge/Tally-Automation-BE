import express from "express";

import { sendToTally } from "../services/tallyClient.js";
import pool from "../db/index.js";
import {
  getCompaniesXML,
  getLedgersXML,
  getLedgerDetailsXML,
  getGroupSummaryCRXML,
  getGroupSummaryDRXML,
  getGroupSummaryBankXML
} from "../services/xmlBuilder.js";

import { parseXML } from "../services/parser.js";

const router = express.Router();

/* ===================================================
   HEALTH API
=================================================== */

router.get("/health", async (req, res) => {

  try {

    return res.status(200).json({

      status: "success",

      message:
        "Sync service healthy",

      services: {

        api: "running",

        tally: "ready"

      },

      timestamp:
        new Date()

    });

  } catch (err) {

    return res.status(500).json({

      status: "error",

      message:
        err.message

    });

  }

});

/* ===================================================
   COMPANY SYNC
=================================================== */

router.get("/companies", async (req, res) => {

  try {

    const xml =
      getCompaniesXML();

    const responseXML =
      await sendToTally(xml);

    const parsed =
      parseXML(responseXML);

    const companies =
      parsed?.ENVELOPE?.BODY?.DATA
        ?.COLLECTION?.COMPANY || [];

    const list =
      Array.isArray(companies)
        ? companies
        : [companies];

    const inserted = [];

    for (const item of list) {

      const name =
        item?.NAME
          ? String(item.NAME).trim()
          : null;

      if (!name) continue;

     const financial_year_start =
  item?.BOOKSFROM
    ? String(
        item.BOOKSFROM
      ).slice(0, 4)
    : null;

const financial_year_end =
  item?.ENDINGAT
    ? String(
        item.ENDINGAT
      ).slice(0, 4)
    : null;

      await pool.query(
        `
        INSERT INTO app.companies
        (
          name,
          financial_year_start,
          financial_year_end,
          created_at,
          updated_at
        )

        VALUES
        (
          $1,
          $2,
          $3,
          NOW(),
          NOW()
        )

        ON CONFLICT(name)

        DO UPDATE SET

          financial_year_start =
            EXCLUDED.financial_year_start,

          financial_year_end =
            EXCLUDED.financial_year_end,

          updated_at = NOW()
        `,
        [
          name,
          financial_year_start,
          financial_year_end
        ]
      );

      inserted.push({

        name,

        financial_year_start,

        financial_year_end

      });

    }

    return res.status(200).json({

      status: "success",

      source: "tally",

      message:
        "Companies synced successfully",

      total:
        inserted.length,

      data:
        inserted

    });

  } catch (err) {

    return res.status(500).json({

      status: "error",

      message:
        err.message

    });

  }

});

/* ===================================================
   LEDGER SYNC
=================================================== */

router.get("/ledgers", async (req, res) => {

  const company =
    req.query.company;

  if (!company) {

    return res.status(400).json({

      status: "error",

      message:
        "company query parameter required"

    });

  }

  try {

    const xml =
      getLedgersXML(company);

    const responseXML =
      await sendToTally(xml);

    const parsed =
      parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA
        ?.COLLECTION;

    if (!collection) {

      throw new Error(
        "No ledger collection found"
      );

    }

    const ledgerNames = [];

    function extractNames(obj) {

      if (!obj) return;

      if (Array.isArray(obj)) {

        return obj.forEach(
          extractNames
        );

      }

      if (typeof obj === "object") {

        if (obj.NAME) {

          ledgerNames.push(
            String(obj.NAME).trim()
          );

        }

        Object.values(obj)
          .forEach(extractNames);

      }

    }

    extractNames(collection);

    const uniqueLedgers =
      [...new Set(ledgerNames)];

    const ledgers = [];

    for (const ledgerName of uniqueLedgers) {

      try {

        const detailsXML =
          getLedgerDetailsXML(
            company,
            ledgerName
          );

        const detailsResponse =
          await sendToTally(
            detailsXML
          );

        if (
          detailsResponse.includes(
            "<ERRORMSG>"
          )
        ) {

          continue;

        }

        const detailsParsed =
          parseXML(
            detailsResponse
          );

        const ledger =
          detailsParsed?.ENVELOPE
            ?.BODY?.DATA
            ?.TALLYMESSAGE?.LEDGER;

        if (!ledger) continue;

        const clean = (value) => {

          if (!value) return null;

          return String(value)
            .replace(
              /&#13;&#10;|\r|\n/g,
              ""
            )
            .trim();

        };

        const finalLedger = {

          company_name:
            company,

          name:
            clean(ledgerName),

          parent_group:
            clean(
              ledger?.PARENT
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
              : clean(
                  ledger?.["ADDRESS.LIST"]?.ADDRESS
                ),

          state:
            clean(
              ledger?.STATENAME
            ),

          country:
            clean(
              ledger?.COUNTRYNAME
            ),

          pincode:
            clean(
              ledger?.PINCODE
            ),

          gst_number:
            clean(
              ledger?.PARTYGSTIN
            ),

          gst_type:
            clean(
              ledger?.GSTREGISTRATIONTYPE
            ),

          pan_number:
            clean(
              ledger?.INCOMETAXNUMBER
            ),

          phone:
            clean(
              ledger?.PHONE
            ),

          mobile:
            clean(
              ledger?.MOBILE
            ),

          email:
            clean(
              ledger?.EMAIL
            ),

          contact_person:
            clean(
              ledger?.CONTACTPERSON
            ),

          opening_balance:
            clean(
              ledger?.OPENINGBALANCE
            ),

          closing_balance:
            clean(
              ledger?.CLOSINGBALANCE
            )

        };

        ledgers.push(
          finalLedger
        );

      } catch (innerErr) {

        console.log(
          "Ledger Error:",
          ledgerName,
          innerErr.message
        );

      }

    }

    return res.status(200).json({

      status: "success",

      source: "tally",

      message:
        "Ledgers synced successfully",

      company,

      total:
        ledgers.length,

      data:
        ledgers

    });

  } catch (err) {

    console.log(
      "❌ LEDGER SYNC ERROR:",
      err.message
    );

    return res.status(500).json({

      status: "error",

      message:
        err.message

    });

  }

});

/* ===================================================
   GROUP SUMMARY CR
=================================================== */

router.get(
  "/group-summary-cr",
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
    .trim();

};

/* =========================================
   CLEAN BALANCE FUNCTION
========================================= */

const cleanBalance = (value) => {

  if (!value) return null;

  const cleaned =
    String(value)
      .replace(/[^\d.-]/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);

  return cleaned.length
    ? cleaned[
        cleaned.length - 1
      ]
    : null;

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
        : clean(
            ledger?.["ADDRESS.LIST"]?.ADDRESS
          ),

    alias:
      clean(
        ledger?.$?.ALIAS ||
        ledger?.["@ALIAS"] ||
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
      clean(
        ledger?.OPENINGBALANCE
      )?.includes("-")
        ? "Cr"
        : "Dr",

    closing_balance_type:
      clean(
        ledger?.CLOSINGBALANCE
      )?.includes("-")
        ? "Cr"
        : "Dr"

  }));

      return res.status(200).json({

        status: "success",

        source: "tally",

        message:
          "Sundry creditors fetched successfully",

        company,

        total:
          data.length,

        data

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY CR ERROR:",
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


/* ===================================================
   GROUP SUMMARY DR
=================================================== */

router.get(
  "/group-summary-dr",
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

      const xml =
        getGroupSummaryDRXML(
          company
        );

      const responseXML =
        await sendToTally(xml);

      const parsed =
        parseXML(responseXML);

      const collection =
        parsed?.ENVELOPE?.BODY?.DATA
          ?.COLLECTION?.LEDGER || [];

      const list =
        Array.isArray(collection)
          ? collection
          : [collection];

      const clean = (value) => {

        if (!value) return null;

        return String(value)
          .replace(
            /&#13;&#10;|\r|\n/g,
            ""
          )
          .trim();

      };

      const cleanBalance = (value) => {

        if (!value) return null;

        const cleaned =
          String(value)
            .replace(/[^\d.-]/g, " ")
            .trim()
            .split(" ")
            .filter(Boolean);

        return cleaned.length
          ? cleaned[
              cleaned.length - 1
            ]
          : null;

      };

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
    "Unknown Ledger"
  ),

          parent_group:
            "Sundry Debtors",

          address:
            Array.isArray(
              ledger?.["ADDRESS.LIST"]?.ADDRESS
            )
              ? ledger["ADDRESS.LIST"]
                  .ADDRESS
                  .map(a => clean(a))
                  .filter(Boolean)
                  .join(", ")
              : clean(
                  ledger?.["ADDRESS.LIST"]?.ADDRESS
                ),

          alias:
            clean(
              ledger?.$?.ALIAS ||
              ledger?.["@ALIAS"] ||
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
  Number(
    cleanBalance(
      ledger?.OPENINGBALANCE
    )
  ) < 0
    ? "Cr"
    : "Dr",

          closing_balance_type:
  Number(
    cleanBalance(
      ledger?.CLOSINGBALANCE
    )
  ) < 0
    ? "Cr"
    : "Dr"

        }));

      return res.status(200).json({

        status: "success",

        source: "tally",

        message:
          "Sundry debtors fetched successfully",

        company,

        total:
          data.length,

        data

      });

    } catch (err) {

      console.log(
        "❌ GROUP SUMMARY DR ERROR:",
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

/* ===================================================
   GROUP SUMMARY BANK
=================================================== */

router.get(
  "/group-summary-bank",
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

      const xml =
        getGroupSummaryBankXML(
          company
        );

      const responseXML =
        await sendToTally(xml);

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
   DEBUG LOG
========================================= */

console.log(
  JSON.stringify(
    list,
    null,
    2
  )
);

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
        : clean(
            ledger?.["ADDRESS.LIST"]?.ADDRESS
          ),

 state:
  clean(

    ledger?.STATENAME ||

    ledger?.LEDSTATENAME ||

    ledger?.STATE

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