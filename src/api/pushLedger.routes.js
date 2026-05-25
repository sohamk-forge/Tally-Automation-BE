import express from "express";

import pool
from "../db/index.js";

import { sendToTally }
from "../services/tallyClient.js";

import {
  createLedgerXML
}
from "../services/pushXmlBuilder.js";

const router = express.Router();

/* =====================================
   PUSH LEDGER API
===================================== */

router.post(

  "/push/ledger",

  async (req, res) => {

    let tallyResponse = null;

    try {

      /* ==============================
         REQUEST BODY
      ============================== */

      const data = req.body;

      /* ==============================
         VALIDATION
      ============================== */

      if (
        !data.company ||
        !data.ledger_name ||
        !data.parent
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company, ledger_name and parent are required"

        });

      }
const companyResult =

  await pool.query(

    `
    SELECT id

  FROM app_test.companies

    WHERE name = $1
    `,

    [

      data.company

    ]

  );

const companyId =

  companyResult.rows[0]?.id || null;
      /* ==============================
         INSERT INTO PUSH_LEDGER
      ============================== */

      await pool.query(

        `
     INSERT INTO app_test.push_ledger (

  company_id,
  company_name,
          ledger_name,
          parent_name,
          opening_balance,
          bill_wise,
          address,
          pincode,
          state,
          country,
          contact_person,
          phone,
          mobile,
          email,
          website,
          pan,
          gstin,
          gst_registration_type,
          status,
          created_at

        )

     VALUES (

  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15,
  $16, $17, $18, $19, NOW()

)
        `,

[

  companyId,
  data.company,
  data.ledger_name,
  data.parent,
  data.opening_balance || 0,
  data.bill_wise || "No",
  data.address || "",
  data.pincode || "",
  data.state || "",
  data.country || "India",
  data.contact_person || "",
  data.phone || "",
  data.mobile || "",
  data.email || "",
  data.website || "",
  data.pan || "",
  data.gstin || "",
  data.gst_registration_type || "",
  "pending"

]

      );

      /* ==============================
         XML
      ============================== */

      const xml =
        createLedgerXML(data);

      /* ==============================
         SEND TO TALLY
      ============================== */

      tallyResponse =
        await sendToTally(xml);

      /* ==============================
         CREATED CHECK
      ============================== */

      const createdMatch =
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        );

      const created =
        createdMatch
          ? Number(createdMatch[1])
          : 0;

      /* ==============================
         ALTERED CHECK
      ============================== */

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );

      const altered =
        alteredMatch
          ? Number(alteredMatch[1])
          : 0;

      /* ==============================
         LINE ERROR
      ============================== */

      const lineErrorMatch =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        );

      const lineError =
        lineErrorMatch
          ? lineErrorMatch[1]
          : null;

      /* ==============================
         FAILURE
      ============================== */

      if (
        created !== 1 &&
        altered !== 1
      ) {

        await pool.query(

          `
       UPDATE app_test.push_ledger

          SET

            status = 'failed',
            error_message = $1,
            tally_response = $2,
            sync_at = NOW(),
            updated_at = NOW()

          WHERE company_name = $3
          AND ledger_name = $4
          `,

          [

            lineError ||
            "Ledger creation failed",

            tallyResponse,

            data.company,

            data.ledger_name

          ]

        );

        return res.status(400).json({

          status: "error",

          message:
            lineError ||
            "Ledger creation failed"

        });

      }

      /* ==============================
         SUCCESS UPDATE
      ============================== */

      await pool.query(

        `
      UPDATE app_test.push_ledger

        SET

         status = 'success',
          tally_response = $1,
          sync_at = NOW(),
          updated_at = NOW()

        WHERE company_name = $2
        AND ledger_name = $3
        `,

        [

          tallyResponse,

          data.company,

          data.ledger_name

        ]

      );

      /* ==============================
         SUCCESS RESPONSE
      ============================== */

      return res.status(200).json({

        status: "success",

        message:
          altered === 1

            ? "Ledger already exists and altered successfully"

            : "Ledger pushed successfully",

        company:
          data.company,

        ledger_name:
          data.ledger_name,

        parent:
          data.parent,

        summary: {

          created,

          altered

        }

      });

    } catch (err) {

      console.log(

        "❌ PUSH LEDGER ERROR:",

        err.message

      );

      try {

        const data = req.body;

        await pool.query(

          `
       UPDATE app_test.push_ledger

          SET

            status = 'failed',
            error_message = $1,
            tally_response = $2,
            sync_at = NOW(),
            updated_at = NOW()

          WHERE company_name = $3
          AND ledger_name = $4
          `,

          [

            err.message,

            tallyResponse,

            data.company,

            data.ledger_name

          ]

        );

      } catch (dbErr) {

        console.log(

          "❌ DB UPDATE ERROR:",

          dbErr.message

        );

      }

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    }

  }

);

export default router;