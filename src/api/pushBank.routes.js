import express from "express";

import pool from "../db/index.js";

import { sendToTally }
from "../services/tallyClient.js";

import {
  createBankLedgerXML
}
from "../services/pushXmlBuilder.js";

const router =
  express.Router();

/* ==================================================
   PUSH BANK LEDGER API
================================================== */

router.post(

  "/push-bank",

  async (req, res) => {

    try {

      /* =====================================
         REQUEST BODY
      ===================================== */

      const {

        company,

        ledger_name,

        opening_balance,

        bank_name,

        branch_name,

        account_holder,

        account_number,

        ifsc_code,

        swift_code,

        address,

        state,

        country,

        pincode,

        contact_person,

        mobile,

        email

      } = req.body;

      /* =====================================
         VALIDATION
      ===================================== */

      if (

        !company ||

        !ledger_name ||

        !bank_name ||

        !account_number ||

        !ifsc_code

      ) {

        return res.status(400).json({

          status:
            "error",

          message:
            "company, ledger_name, bank_name, account_number and ifsc_code required"

        });

      }

      /* =====================================
         DUPLICATE CHECK
      ===================================== */

      const existing =

        await pool.query(

          `
          SELECT id

          FROM app_test.push_bank

          WHERE LOWER(ledger_name)
          = LOWER($1)

          LIMIT 1
          `,

          [ledger_name]

        );

      if (existing.rows.length > 0) {

        return res.status(400).json({

          status:
            "error",

          message:
            "Bank ledger already exists"

        });

      }

      /* =====================================
         BUILD XML DATA
      ===================================== */

      const xmlData = {

        company,

        ledger_name,

        parent:
          "Bank Accounts",

        opening_balance:
          opening_balance || 0,

        bill_wise:
          "No",

        /* =================================
           ADDRESS DETAILS
        ================================= */

        address,

        state,

        country:
          country || "India",

        pincode,

        contact_person,

        mobile,

        email,

        /* =================================
           BANK DETAILS
        ================================= */

        bank_name,

        branch_name,

        account_holder,

        account_number,

        ifsc_code,

        swift_code

      };

      /* =====================================
         GENERATE XML
      ===================================== */

     const xml =

  createBankLedgerXML(
    xmlData
  );

      /* =====================================
         SEND TO TALLY
      ===================================== */

      const tallyResponse =

        await sendToTally(
          xml
        );

      /* =====================================
         STORE PUSH LOG
      ===================================== */

      await pool.query(

        `
        INSERT INTO app_test.push_bank
        (

          company_name,

          ledger_name,

          parent_group,

          opening_balance,

          bank_name,

          branch_name,

          account_holder,

          account_number,

          ifsc_code,

          swift_code,

          address,

          state,

          country,

          pincode,

          contact_person,

          mobile,

          email,

          tally_response,

          created_at

        )

        VALUES
        (

          $1,  $2,  $3,  $4,
          $5,  $6,  $7,  $8,
          $9,  $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, NOW()

        )
        `,

        [

          company,

          ledger_name,

          "Bank Accounts",

          opening_balance || 0,

          bank_name,

          branch_name,

          account_holder,

          account_number,

          ifsc_code,

          swift_code,

          address,

          state,

          country || "India",

          pincode,

          contact_person,

          mobile,

          email,

          tallyResponse

        ]

      );

      /* =====================================
         SUCCESS RESPONSE
      ===================================== */

      return res.status(200).json({

        status:
          "success",

        message:
          "Bank ledger pushed successfully",

        company,

        ledger_name,

        bank_name,

        account_number,

        ifsc_code

      });

    } catch (err) {

      console.log(
        err.message
      );

      return res.status(500).json({

        status:
          "error",

        message:
          err.message

      });

    }

  }

);

export default router;