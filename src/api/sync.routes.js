import express from "express";
import pool from "../db/index.js";

import { sendToTally } from "../services/tallyClient.js";

import {
  getCompaniesXML,
  getLedgersXML,
  getLedgerDetailsXML
} from "../services/xmlBuilder.js";

import { parseXML } from "../services/parser.js";

const router = express.Router();

/* ===================================================
   HEALTH API
=================================================== */

router.get("/health", async (req, res) => {

  try {

    await pool.query("SELECT 1");

    return res.status(200).json({

      status: "success",

      message:
        "Sync service healthy",

      services: {

        api: "running",

        database: "connected",

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
        item?.BOOKSFROM || null;

      const financial_year_end =
        item?.ENDINGAT || null;

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

    /* =========================================
       STEP 1:
       FETCH ALL LEDGER NAMES
    ========================================= */

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

    /* =========================================
       EXTRACT NAMES
    ========================================= */

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

    /* =========================================
       STEP 2:
       FETCH FULL DETAILS
    ========================================= */

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
        console.log(
  Object.keys(ledger)
);

        /* =====================================
           CLEAN FUNCTION
        ===================================== */

        const clean = (value) => {

          if (!value) return null;

          return String(value)
            .replace(
              /&#13;&#10;|\r|\n/g,
              ""
            )
            .trim();

        };

        /* =====================================
           BALANCE
        ===================================== */

        let opening_balance = 0;

        let opening_balance_type =
          "Dr";

        if (
          ledger.OPENINGBALANCE
        ) {

          const balance =
            parseFloat(
              ledger.OPENINGBALANCE
            );

          if (!isNaN(balance)) {

            opening_balance =
              Math.abs(balance);

            opening_balance_type =
              balance < 0
                ? "Cr"
                : "Dr";

          }

        }

        /* =====================================
   FINAL OBJECT
===================================== */

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
  ) ||
  clean(
    ledger?.LEDSTATENAME
  ) ||
  clean(
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

  gst_number:
  clean(
    ledger?.GSTIN
  ) ||
  clean(
    ledger?.PARTYGSTIN
  ),

 gst_type:
  clean(
    ledger?.REGISTRATIONTYPE
  ) ||
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
  ) ||
  clean(
    ledger?.LEDGERPHONE
  ),

mobile:
  clean(
    ledger?.MOBILE
  ) ||
  clean(
    ledger?.LEDGERMOBILE
  ),

email:
  clean(
    ledger?.EMAIL
  ) ||
  clean(
    ledger?.LEDGEREMAIL
  ),

  contact_person:
    clean(
      ledger?.CONTACTPERSON
    ),

  opening_balance,

  opening_balance_type,

  closing_balance:
    clean(
      ledger?.CLOSINGBALANCE
    ),

  credit_period:
    clean(
      ledger?.CREDITPERIOD
    ),

  bill_wise:
    clean(
      ledger?.ISBILLWISEON
    ),

  revenue_ledger:
    clean(
      ledger?.ISREVENUE
    ),

  deemed_positive:
    clean(
      ledger?.ISDEEMEDPOSITIVE
    )

};

ledgers.push(
  finalLedger
);
        /* =====================================
           UPSERT DATABASE
        ===================================== */

        await pool.query(
          `
          INSERT INTO app.ledgers
          (
            company_name,
            name,
            parent_group,
            address,
            state,
            country,
            pincode,
            gst_number,
            gst_type,
            pan_number,
            phone,
            mobile,
            email,
            contact_person,
            opening_balance,
            opening_balance_type,
            closing_balance,
            credit_period,
            bill_wise,
            revenue_ledger,
            deemed_positive,
            created_at,
            updated_at
          )

          VALUES
          (
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,$14,
            $15,$16,$17,$18,
            $19,$20,$21,
            NOW(),
            NOW()
          )

          ON CONFLICT
          (company_name, name)

          DO UPDATE SET

            parent_group =
              EXCLUDED.parent_group,

            address =
              EXCLUDED.address,

            state =
              EXCLUDED.state,

            country =
              EXCLUDED.country,

            pincode =
              EXCLUDED.pincode,

            gst_number =
              EXCLUDED.gst_number,

            gst_type =
              EXCLUDED.gst_type,

            pan_number =
              EXCLUDED.pan_number,

            phone =
              EXCLUDED.phone,

            mobile =
              EXCLUDED.mobile,

            email =
              EXCLUDED.email,

            contact_person =
              EXCLUDED.contact_person,

            opening_balance =
              EXCLUDED.opening_balance,

            opening_balance_type =
              EXCLUDED.opening_balance_type,

            closing_balance =
              EXCLUDED.closing_balance,

            credit_period =
              EXCLUDED.credit_period,

            bill_wise =
              EXCLUDED.bill_wise,

            revenue_ledger =
              EXCLUDED.revenue_ledger,

            deemed_positive =
              EXCLUDED.deemed_positive,

            updated_at = NOW()
          `,
          [

            finalLedger.company_name,

            finalLedger.name,

            finalLedger.parent_group,

            finalLedger.address,

            finalLedger.state,

            finalLedger.country,

            finalLedger.pincode,

            finalLedger.gst_number,

            finalLedger.gst_type,

            finalLedger.pan_number,

            finalLedger.phone,

            finalLedger.mobile,

            finalLedger.email,

            finalLedger.contact_person,

            finalLedger.opening_balance,

            finalLedger.opening_balance_type,

            finalLedger.closing_balance,

            finalLedger.credit_period,

            finalLedger.bill_wise,

            finalLedger.revenue_ledger,

            finalLedger.deemed_positive

          ]
        );

      } catch (innerErr) {

        console.log(
          "Ledger Error:",
          ledgerName,
          innerErr.message
        );

      }

    }

    /* =========================================
       RESPONSE
    ========================================= */

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

export default router;