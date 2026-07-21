import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";

import { sendToTally } from "../services/tallyClient.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  getStockItemOpeningXML
} from "../services/pushXmlBuilder.js";

import {
  alterStockItemQueue,
  ALTER_STOCK_ITEM_QUEUE_NAME,
  ALTER_STOCK_ITEM_JOB_OPTIONS,
  getAlterStockItemJobId
} from "../queues/alterStockItem.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryError(error) {

  const code =
    String(error?.code || "")
      .toUpperCase();

  const message =
    String(error?.message || "")
      .toLowerCase();

  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND"
  ].includes(code)

  ||

  message.includes("timeout")

  ||

  message.includes("network")

  ||

  message.includes("server unavailable")

  ||

  message.includes("fetch failed");
}

async function enqueuePendingAlterJobs() {

  const result =
    await pool.query(
      `
      SELECT id
      FROM ${DB_SCHEMA}.push_stock_item
      WHERE
        status = 'success'
        AND (
          opening_quantity IS NOT NULL
          OR opening_rate IS NOT NULL
          OR opening_value IS NOT NULL
        )
      ORDER BY id ASC
      `
    );

  for (const row of result.rows) {

    // FOR TESTING ONLY - creates unique job IDs
    const jobId =
      `alter-stock-item-${row.id}-${Date.now()}`;
    
    // FOR PRODUCTION - use this instead:
    // const jobId = getAlterStockItemJobId(row.id);

    const existingJob =
      await alterStockItemQueue.getJob(
        jobId
      );

    if (existingJob) {

      const state =
        await existingJob.getState();

      const isProcessable = [
        "waiting",
        "active",
        "delayed",
        "prioritized",
        "paused",
        "waiting-children"
      ].includes(state);

      if (isProcessable) {
        continue;
      }

      await existingJob.remove();
    }

    await alterStockItemQueue.add(
      "push-alter-stock-item",
      {
        stockItemId: row.id
      },
      {
        ...ALTER_STOCK_ITEM_JOB_OPTIONS,
        jobId
      }
    );
  }
}

const worker = new Worker(

  ALTER_STOCK_ITEM_QUEUE_NAME,

  async (job) => {

    const { stockItemId } =
      job.data;

    const result =
      await pool.query(
        `
        SELECT *
        FROM ${DB_SCHEMA}.push_stock_item
        WHERE id = $1
        `,
        [stockItemId]
      );

    const row = result.rows[0];

    // BUG 1 FIX: Check if row exists BEFORE using it
    if (!row) {
      console.error(
        `Stock Item ${stockItemId} not found`
      );
      return;
    }

    console.log("STOCK ITEM DATA:");
    console.log({
      id: row.id,
      item_name: row.item_name,
      company_name: row.company_name,
      opening_quantity: row.opening_quantity,
      opening_rate: row.opening_rate,
      opening_value: row.opening_value
    });

    try {

      const xml =
        getStockItemOpeningXML({

          company:
            row.company_name,

          itemName:
            row.item_name,

          unit:
            row.unit_name,

          openingQuantity:
            row.opening_quantity,

          openingRate:
            row.opening_rate,

          openingValue:
            row.opening_value

        });
      
      console.log("ALTER XML:");
      console.log(xml);

      const tallyResponse =
        await sendToTally(xml);
        
      console.log("ALTER RESPONSE:");
      console.log(tallyResponse);

      const createdMatch =
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        );

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );
      
      const exceptionMatch =
        tallyResponse.match(
          /<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/
        );

      const created =
        createdMatch
          ? Number(createdMatch[1])
          : 0;

      const altered =
        alteredMatch
          ? Number(alteredMatch[1])
          : 0;
      
      const exceptions =
        exceptionMatch
          ? Number(exceptionMatch[1])
          : 0;

      console.log("CREATED:", created);
      console.log("ALTERED:", altered);
      console.log("EXCEPTIONS:", exceptions);

      const isSuccess =
        created === 1 ||
        altered === 1;

      if (!isSuccess) {

        throw new Error(
          `Opening stock alter failed - CREATED: ${created}, ALTERED: ${altered}, EXCEPTIONS: ${exceptions}`
        );
      }

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_stock_item
        SET
          updated_at = NOW()
        WHERE id = $1
        `,
        [stockItemId]
      );

      console.log(
        `Opening stock updated: ${row.item_name}`
      );

      return {
        stockItemId
      };

    } catch (error) {

      if (
        isTemporaryError(error)
      ) {

        throw error;
      }

      console.error(
        `Alter stock item failed: ${stockItemId}`,
        error.message
      );

      return {
        stockItemId,
        status: "failed"
      };
    }
  },

  {
    connection,
    concurrency: 10
  }
);

worker.on(
  "completed",
  (job) => {

    console.log(
      `Alter stock item completed: ${job.id}`
    );
  }
);

worker.on(
  "failed",
  (job, error) => {

    console.error(
      `Alter stock item failed: ${job?.id}`,
      error.message
    );
  }
);

worker.on(
  "error",
  (error) => {

    console.error(
      "Alter Stock Item Worker Error:",
      error.message
    );
  }
);

// FOR TESTING ONLY - uncomment to enable recovery
// enqueuePendingAlterJobs()
//   .catch((error) => {
//     console.error(
//       "Alter Stock Item Recovery Failed:",
//       error.message
//     );
//   });

console.log(
  "Push Alter Stock Item BullMQ Worker Started"
);

export default worker;