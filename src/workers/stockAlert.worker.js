import { Worker } from "bullmq";
import IORedis from "ioredis";
// import axios from "axios";

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  STOCK_ALERT_QUEUE_NAME
} from "../queues/stockAlert.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",

  port: Number(
    process.env.REDIS_PORT || 6379
  ),

  maxRetriesPerRequest: null
});

new Worker(

  STOCK_ALERT_QUEUE_NAME,

  async (job) => {

    const { companyId } =
  job.data;

    console.log("");
    console.log(
      "================================="
    );
    console.log(
      "STOCK ALERT WORKER START"
    );
    console.log(
  "COMPANY ID:",
  companyId
);
    console.log(
      "================================="
    );

    try {

    //   /* ============================
    //      STEP 1
    //      SYNC LATEST STOCK
    //   ============================ */

    //   const baseUrl =
    //     process.env.BASE_URL ||
    //     "http://localhost:5000";

    //   await axios.get(

    //     `${baseUrl}/api/sync/stock-group-summary-sync`,

    //     {
    //       params: {
    //         company
    //       }
    //     }

    //   );

    //   console.log(
    //     "✅ STOCK SUMMARY SYNC COMPLETE"
    //   );

      /* ============================
         STEP 2
         GET ALERT ITEMS
      ============================ */

     const result =
  await pool.query(

    `
    SELECT
      sa.id,
      sa.item_name,
      sa.minimum_alert_quantity,
      COALESCE(s.quantity, 0) AS quantity

    FROM ${DB_SCHEMA}.stock_alerts sa

    LEFT JOIN ${DB_SCHEMA}.stock_group_summary s

    ON
      LOWER(TRIM(sa.item_name))
      =
      LOWER(TRIM(s.item_name))

    AND
      sa.company_id = s.company_id

    WHERE
      sa.company_id = $1

    AND
      sa.is_active = true
    `,

    [companyId]

  );

      console.log(
        "TOTAL ITEMS:",
        result.rows.length
      );

      /* ============================
         STEP 3
         CALCULATE
      ============================ */

      let updated = 0;

      for (const row of result.rows) {

        const currentQuantity =
          Number(
            row.quantity || 0
          );

        const minimumQuantity =
          Number(
            row.minimum_alert_quantity || 0
          );

        const shortageQuantity =
          Math.max(
            0,
            minimumQuantity -
            currentQuantity
          );

        const isLowStock =
  currentQuantity <= minimumQuantity;

        console.log({
          item_name:
            row.item_name,

          currentQuantity,

          minimumQuantity,

          shortageQuantity,

          isLowStock
        });

        /* ==========================
           UPDATE ALERT TABLE
        ========================== */

        await pool.query(

          `
          UPDATE ${DB_SCHEMA}.stock_alerts
          SET

            current_quantity = $1,

            shortage_quantity = $2,

            is_low_stock = $3,

            updated_at = NOW()

          WHERE id = $4
          `,

          [

            currentQuantity,

            shortageQuantity,

            isLowStock,

            row.id

          ]

        );

        updated++;

      }

      console.log(
        `✅ UPDATED ${updated} ALERT RECORDS`
      );

      return {
        success: true,
        updated
      };

    } catch (err) {

      console.log(
        "❌ STOCK ALERT WORKER ERROR:",
        err.message
      );

      throw err;

    }

  },

  {
    connection
  }

);

console.log(
  "🚀 STOCK ALERT WORKER STARTED"
);