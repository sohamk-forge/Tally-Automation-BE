// =========================================
// src/api/pushLedger.routes.js
// =========================================

import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { ledgerQueue } from "../queues/ledger.queue.js";

import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

const router = express.Router();

/* =====================================
   PUSH LEDGER API
===================================== */

router.post(

  "/push/ledger",

  verifySession(),

  async (req, res) => {

    try {

      const userId = await getLocalUserId(
        req.session.getUserId()
      );

      if (!userId) {
        return res.status(404).json({
          status: "error",
          message: "No profile found for this account"
        });
      }

      const data =
        req.body;

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

      /* ==============================
         COMPANY
      ============================== */

      const companyResult =
        await pool.query(

          `
          SELECT id
          FROM ${DB_SCHEMA}.companies
          WHERE TRIM(name)=TRIM($1)
          LIMIT 1
          `,

          [data.company]

        );

      const companyId =
        companyResult.rows[0]?.id || null;

      /* ==============================
         DUPLICATE CHECK
      ============================== */

      const duplicateResult =
        await pool.query(

          `
          SELECT id
          FROM ${DB_SCHEMA}.push_ledger
          WHERE
            LOWER(TRIM(company_name))
              = LOWER(TRIM($1))
          AND
            LOWER(TRIM(ledger_name))
              = LOWER(TRIM($2))
          AND
            status IN
            (
              'pending',
              'processing',
              'success'
            )
          LIMIT 1
          `,

          [
            data.company,
            data.ledger_name
          ]

        );

      if (
        duplicateResult.rows.length
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "Ledger already queued or synced"

        });

      }

      /* ==============================
         INSERT
      ============================== */

      const insertResult =
        await pool.query(

          `
          INSERT INTO ${DB_SCHEMA}.push_ledger
          (

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
            created_at,
            updated_at

          )

          VALUES
          (

            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,
            $16,$17,$18,
            'pending',
            NOW(),
            NOW()

          )

          RETURNING id
          `,

          [

            companyId,

            data.company?.trim(),

            data.ledger_name?.trim(),

            data.parent?.trim(),

            Number(
              data.opening_balance || 0
            ),

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

            data.gst_registration_type || ""

          ]

        );

      const ledgerId =
        insertResult.rows[0].id;

      /* ==============================
         ADD TO BULLMQ
      ============================== */

      const job =
        await ledgerQueue.add(

          "push-ledger",

          {
            ledgerId,
            userId
          },

          {

            attempts: 5,

            backoff: {

              type:
                "exponential",

              delay:
                5000

            },

            removeOnComplete:
              100,

            removeOnFail:
              100

          }

        );

      console.log(

        `📥 QUEUED LEDGER ${ledgerId} by user ${userId}`

      );

      /* ==============================
         RESPONSE
      ============================== */

      return res.status(200).json({

        status:
          "success",

        message:
          "Ledger queued successfully",

        ledgerId,

        jobId:
          job.id

      });

    } catch (err) {

      console.log(

        "❌ PUSH LEDGER ERROR:",

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