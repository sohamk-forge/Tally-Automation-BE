// =========================================
// src/workers/pushBank.worker.js
// =========================================

import pool from "../db/index.js";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  createBankLedgerXML
} from "../services/pushXmlBuilder.js";

/* =========================================
   PUSH BANK WORKER
========================================= */

const processPushBankJobs =
  async () => {

    try {

      /* =====================================
         GET PENDING RECORDS
      ===================================== */

      const result =

        await pool.query(

          `
          SELECT *

          FROM app_test.push_bank

          WHERE sync_status = 'pending'

          ORDER BY id ASC

          LIMIT 5
          `

        );

      /* =====================================
         NO RECORDS
      ===================================== */

      if (!result.rows.length) {

        return;

      }

      /* =====================================
         LOOP RECORDS
      ===================================== */

      for (const row of result.rows) {

        let tallyResponse = null;

        try {

          console.log(

            `PUSHING BANK: ${row.ledger_name}`

          );

          console.log(

            "COMPANY NAME:",

            row.company_name

          );

          /* =================================
             XML
          ================================= */

          const xml =
            createBankLedgerXML({

              company:
                row.company_name?.trim(),

              ledger_name:
                row.ledger_name,

              parent:
                row.parent_group,

              opening_balance:
                row.opening_balance,

              bank_name:
                row.bank_name,

              branch_name:
                row.branch_name,

              account_holder:
                row.account_holder,

              account_number:
                row.account_number,

              ifsc_code:
                row.ifsc_code,

              swift_code:
                row.swift_code,

              address:
                row.address,

              state:
                row.state,

              country:
                row.country,

              pincode:
                row.pincode,

              contact_person:
                row.contact_person,

              mobile:
                row.mobile,

              email:
                row.email

            });

          /* =================================
             SEND TO TALLY
          ================================= */

          tallyResponse =
            await sendToTally(xml);

          console.log(

            "📥 RAW XML RESPONSE:\n",

            tallyResponse

          );

          /* =================================
             CREATED CHECK
          ================================= */

          const createdMatch =
            tallyResponse.match(
              /<CREATED>(\d+)<\/CREATED>/
            );

          const created =
            createdMatch
              ? Number(createdMatch[1])
              : 0;

          /* =================================
             ALTERED CHECK
          ================================= */

          const alteredMatch =
            tallyResponse.match(
              /<ALTERED>(\d+)<\/ALTERED>/
            );

          const altered =
            alteredMatch
              ? Number(alteredMatch[1])
              : 0;

          /* =================================
             FAILED RESPONSE
          ================================= */

          if (
            created !== 1 &&
            altered !== 1
          ) {

            await pool.query(

              `
              UPDATE app_test.push_bank

              SET

                error_message = $1,
                tally_response = $2,
                updated_at = NOW(),
                synced_at = NOW()

              WHERE id = $3
              `,

              [

                "Tally push failed",

                tallyResponse,

                row.id

              ]

            );

            console.log(

              `FAILED: ${row.ledger_name}`

            );

            continue;

          }

          /* =================================
             SUCCESS
          ================================= */

          await pool.query(

            `
            UPDATE app_test.push_bank

            SET

              sync_status = 'success',
              tally_response = $1,
              error_message = NULL,
              updated_at = NOW(),
              synced_at = NOW()

            WHERE id = $2
            `,

            [

              tallyResponse,

              row.id

            ]

          );

          console.log(

            `SUCCESS: ${row.ledger_name}`

          );

        } catch (err) {

          console.log(

            `TALLY OFF: ${row.ledger_name}`

          );

          console.log(
            err.message
          );

          /* =================================
             KEEP PENDING FOR RETRY
          ================================= */

          await pool.query(

            `
            UPDATE app_test.push_bank

            SET

              error_message = $1,
              updated_at = NOW()

            WHERE id = $2
            `,

            [

              err.message,

              row.id

            ]

          );

        }

      }

    } catch (err) {

      console.log(

        "WORKER ERROR:",

        err.message

      );

    }

  };

/* =========================================
   RUN EVERY 30 SECONDS
========================================= */

setInterval(

  processPushBankJobs,

  30000

);

console.log(
  "Push Bank Worker Started"
);