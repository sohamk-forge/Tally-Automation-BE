// =========================================
// src/workers/pushOdBank.worker.js
// =========================================

import pool from "../db/index.js";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  createOdBankXML
} from "../services/pushXmlBuilder.js";

/* =========================================
   PUSH OD / OCC BANK WORKER
========================================= */

const processPushOdBankJobs =
  async () => {

    try {

      const result =
        await pool.query(

          `
          SELECT *

          FROM app_test.bank_od_accounts

          WHERE sync_status = 'pending'

          ORDER BY id ASC

          LIMIT 5
          `

        );

      if (!result.rows.length) {

        return;

      }

      for (const row of result.rows) {

        try {

          console.log(

            `PUSHING OD/OCC: ${row.ledger_name}`

          );

          const xml =
            createOdBankXML({

              company:
                row.company_name,

              ledger_name:
                row.ledger_name,

              account_type:
                row.account_type,

              opening_balance:
                row.opening_balance,

              od_limit:
                row.od_limit,

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

          const tallyResponse =
            await sendToTally(xml);

          console.log(

            "📥 RAW XML RESPONSE:\n",

            tallyResponse

          );

          const createdMatch =
            tallyResponse.match(
              /<CREATED>(\d+)<\/CREATED>/
            );

          const created =
            createdMatch
              ? Number(createdMatch[1])
              : 0;

          const alteredMatch =
            tallyResponse.match(
              /<ALTERED>(\d+)<\/ALTERED>/
            );

          const altered =
            alteredMatch
              ? Number(alteredMatch[1])
              : 0;

          /* ===============================
             FAILED
          =============================== */

          if (

            created < 1 &&

            altered < 1

          ) {

            await pool.query(

              `
              UPDATE app_test.bank_od_accounts

              SET

                error_message = $1,

                tally_response = $2,

                updated_at = NOW()

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

          /* ===============================
             SUCCESS
          =============================== */

          await pool.query(

            `
            UPDATE app_test.bank_od_accounts

            SET

              sync_status = 'success',

              tally_response = $1,

              error_message = NULL,

              synced_at = NOW(),

              updated_at = NOW()

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

            `OD/OCC FAILED: ${row.ledger_name}`

          );

          console.log(

            err.message

          );

          await pool.query(

            `
            UPDATE app_test.bank_od_accounts

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

        "OD/OCC WORKER ERROR:",

        err.message

      );

    }

  };

/* =========================================
   RUN IMMEDIATELY
========================================= */

processPushOdBankJobs();

/* =========================================
   RUN EVERY 30 SECONDS
========================================= */

setInterval(

  processPushOdBankJobs,

  30000

);

console.log(

  "Push OD/OCC Worker Started"

);