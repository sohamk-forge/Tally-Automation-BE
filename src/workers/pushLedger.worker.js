// =========================================
// src/workers/pushLedger.worker.js
// =========================================

import pool from "../db/index.js";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  createLedgerXML
} from "../services/pushXmlBuilder.js";

/* =========================================
   PUSH LEDGER WORKER
========================================= */

const processPushLedgerJobs =
  async () => {

    try {

      /* =====================================
         GET PENDING RECORDS
      ===================================== */

      const result =

        await pool.query(

          `
          SELECT *

          FROM app_test.push_ledger

          WHERE status = 'pending'

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

            `PUSHING LEDGER: ${row.ledger_name}`

          );

          console.log(

            "COMPANY NAME:",

            row.company_name

          );

          /* =================================
             XML
          ================================= */

          const xml =
            createLedgerXML({

              company:
                row.company_name?.trim(),

              ledger_name:
                row.ledger_name,

              parent:
                row.parent_name,

              opening_balance:
                row.opening_balance,

              bill_wise:
                row.bill_wise,

              address:
                row.address,

              pincode:
                row.pincode,

              state:
                row.state,

              country:
                row.country,

              contact_person:
                row.contact_person,

              phone:
                row.phone,

              mobile:
                row.mobile,

              email:
                row.email,

              website:
                row.website,

              pan:
                row.pan,

              gstin:
                row.gstin,

              gst_registration_type:
                row.gst_registration_type

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
              UPDATE app_test.push_ledger

              SET

                error_message = $1,
                tally_response = $2,
                updated_at = NOW(),
                sync_at = NOW()

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
            UPDATE app_test.push_ledger

            SET

              status = 'success',
              tally_response = $1,
              error_message = NULL,
              updated_at = NOW(),
              sync_at = NOW()

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
            UPDATE app_test.push_ledger

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

  processPushLedgerJobs,

  30000

);

console.log(
  "Push Ledger Worker Started"
);