import express from "express";

import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { assertCompanyAccess } from "../middleware/companyAccess.middleware.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  stockAlertQueue,
  STOCK_ALERT_JOB_OPTIONS,
  getStockAlertJobId
} from "../queues/stockAlert.queue.js";

const router =
  express.Router();

/* =====================================
   PUSH STOCK ALERT API
===================================== */

router.post(

  "/push/stock-alert",

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
        !data.company_id ||
        !data.item_name ||
        data.minimum_alert_quantity == null
      ) {

        return res.status(400).json({

          status: "error",

          message:
            "company_id, item_name and minimum_alert_quantity are required"

        });

      }

      /* ==============================
         COMPANY
      ============================== */

      const companyId = String(data.company_id).trim();

      // Ownership check — the caller must have access to this company id.
      if (!(await assertCompanyAccess(req, res, companyId))) return;

      const companyResult = await pool.query(
        `SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1 LIMIT 1`,
        [companyId]
      );

      if (!companyResult.rows.length) {
        return res.status(404).json({
          status: "error",
          message: `Company not found: ${companyId}`
        });
      }

      const companyName = companyResult.rows[0].name;

      // const hasAccess = await checkCompanyAccess(userId, companyId);
      // if (!hasAccess) {
      //   return res.status(403).json({
      //     status: "error",
      //     message: "You don't have access to this company"
      //   });
      // }

      /* ==============================
         CHECK EXISTING ALERT
      ============================== */

      const existingResult =
        await pool.query(

          `
          SELECT id
          FROM ${DB_SCHEMA}.stock_alerts
          WHERE
            (
              company_id = $3
              OR (
                company_id IS NULL
                AND LOWER(TRIM(company_name)) = LOWER(TRIM($1))
              )
            )
          AND
            LOWER(TRIM(item_name))
              = LOWER(TRIM($2))
          LIMIT 1
          `,

          [
            companyName,
            data.item_name,
            companyId
          ]

        );

      /* ==============================
         UPDATE EXISTING
      ============================== */

      if (
        existingResult.rows.length
      ) {

        await pool.query(

          `
          UPDATE ${DB_SCHEMA}.stock_alerts
          SET
            minimum_alert_quantity = $1,
            is_active = true,
            updated_at = NOW()
          WHERE id = $2
          `,

          [

            Number(
              data.minimum_alert_quantity
            ),

            existingResult.rows[0].id

          ]

        );

        /* ==========================
           TRIGGER WORKER
        ========================== */

        await stockAlertQueue.add(

          "stock-alert",

          {
            companyId
          },

          {

            ...STOCK_ALERT_JOB_OPTIONS,

            jobId:
              `${companyId}-${Date.now()}`

          }

        );

        return res.status(200).json({

          status:
            "success",

          message:
            "Stock alert updated successfully",

          alertId:
            existingResult.rows[0].id

        });

      }

      /* ==============================
         INSERT NEW ALERT
      ============================== */

      const insertResult =
        await pool.query(

          `
          INSERT INTO ${DB_SCHEMA}.stock_alerts
          (

            company_id,
            company_name,
            item_name,
            minimum_alert_quantity,
            is_active,
            created_at,
            updated_at

          )

          VALUES
          (

            $1,$2,$3,$4,
            true,
            NOW(),
            NOW()

          )

          RETURNING id
          `,

          [

            companyId,

            companyName,

            data.item_name?.trim(),

            Number(
              data.minimum_alert_quantity
            )

          ]

        );

      const alertId =
        insertResult.rows[0].id;

      /* ==========================
         TRIGGER WORKER
      ========================== */

      await stockAlertQueue.add(

        "stock-alert",

        {
          companyId
        },

        {

          ...STOCK_ALERT_JOB_OPTIONS,

          jobId:
            `${companyId}-${Date.now()}`

        }

      );

      /* ==============================
         RESPONSE
      ============================== */

      return res.status(200).json({

        status:
          "success",

        message:
          "Stock alert created successfully",

        alertId

      });

    } catch (err) {

      console.log(

        "❌ STOCK ALERT ERROR:",

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