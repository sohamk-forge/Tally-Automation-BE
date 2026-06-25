import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import { getStockItemCreateXML } from "../services/pushXmlBuilder.js";
import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS,
  STOCK_ITEM_QUEUE_NAME,
  getStockItemJobId
} from "../queues/stockItem.queue.js";

import {
  alterStockItemQueue,
  ALTER_STOCK_ITEM_JOB_OPTIONS,
  getAlterStockItemJobId
} from "../queues/alterStockItem.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryStockItemError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND"
  ].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("timeout") ||
    message.includes("tally server unavailable") ||
    message.includes("server unavailable") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout");
}

async function markStalePendingAsFailed() {
  const result = await pool.query(
    `
    UPDATE app_test.push_stock_item
    SET
      status = 'failed',
      last_error = 'Upload interrupted / Worker restarted',
      updated_at = NOW()
    WHERE status = 'pending'
      AND updated_at < NOW() - INTERVAL '5 minutes'
    RETURNING id
    `
  );

  console.log(
    `Marked ${result.rowCount} stale pending stock items as failed`
  );
}

async function enqueuePendingStockItemJobs() {
  const result = await pool.query(
    `
    SELECT id
    FROM app_test.push_stock_item
    WHERE status = 'pending'
    ORDER BY id ASC
    `
  );

  for (const row of result.rows) {
    const jobId = getStockItemJobId(row.id);
    const existingJob = await stockItemQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
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

    await stockItemQueue.add(
      "push-stock-item",
      { stockItemId: row.id },
      {
        ...STOCK_ITEM_JOB_OPTIONS,
        jobId
      }
    );
  }
}

const worker = new Worker(
  STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { stockItemId } = job.data;

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.push_stock_item
      WHERE id = $1
      `,
      [stockItemId]
    );

    const row = result.rows[0];

    if (!row) {
      console.error(
        `Stock item ${stockItemId} not found`
      );

      return { stockItemId, status: "not_found" };
    }

    try {
      const xml = getStockItemCreateXML({
        company: row.company_name,
        itemName: row.item_name,
        alias: row.alias_name,
        unit: row.unit_name,
        description: row.description,
        hsnCode: row.hsn_code,
        cgst: row.cgst_rate,
        sgst: row.sgst_rate,
        igst: row.igst_rate,
        gstApplicable: row.gst_applicable,
        parentGroup: row.parent_group,
        applicableFrom: "20250401"
      });

      const tallyResponse =
        await sendToTally(xml);

      const createdMatch =
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        );

      const created = createdMatch
        ? Number(createdMatch[1])
        : 0;

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );

      const altered = alteredMatch
        ? Number(alteredMatch[1])
        : 0;

      const lineErrorMatch =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        );

      const lineError = lineErrorMatch
        ? lineErrorMatch[1]
        : null;

      const isSuccess =
        created === 1 ||
        altered === 1;

      if (!isSuccess) {
        const errorMessage =
          lineError || "Tally push failed";

        await pool.query(
          `
          UPDATE app_test.push_stock_item
          SET
            status = 'failed',
            tally_response = $1,
            error_count = COALESCE(error_count, 0) + 1,
            last_error = $2,
            updated_at = NOW()
          WHERE id = $3
          `,
          [
            tallyResponse,
            errorMessage,
            stockItemId
          ]
        );

        return {
          stockItemId,
          status: "failed"
        };
      }

      await pool.query(
        `
        UPDATE app_test.push_stock_item
        SET
          status = 'success',
          tally_response = $1,
          error_count = 0,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          tallyResponse,
          stockItemId
        ]
      );

      await alterStockItemQueue.add(
        "push-alter-stock-item",
        {
          stockItemId
        },
        {
          ...ALTER_STOCK_ITEM_JOB_OPTIONS,
          jobId: getAlterStockItemJobId(stockItemId)
        }
      );

      console.log(
        `Opening stock queued automatically: ${stockItemId}`
      );

      return { stockItemId };
    } catch (error) {
      if (isTemporaryStockItemError(error)) {
        await pool.query(
          `
          UPDATE app_test.push_stock_item
          SET
            status = 'pending',
            error_count = COALESCE(error_count, 0) + 1,
            last_error = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            stockItemId
          ]
        );

        throw error;
      }

      await pool.query(
        `
        UPDATE app_test.push_stock_item
        SET
          status = 'failed',
          error_count = COALESCE(error_count, 0) + 1,
          last_error = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          stockItemId
        ]
      );

      return {
        stockItemId,
        status: "failed"
      };
    }
  },
  {
    connection,
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  console.log(
    `Stock item job completed: ${job.id}`
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `Stock item job failed: ${job?.id}`,
    error.message
  );

  if (!job) {
    return;
  }

  const maximumAttempts =
    Number(job.opts.attempts || 1);

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { stockItemId } = job.data;

    await pool.query(
      `
      UPDATE app_test.push_stock_item
      SET
        status = 'failed',
        last_error = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        stockItemId
      ]
    );
  } catch (updateError) {
    console.error(
      `Stock item final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "Stock item worker error:",
    error.message
  );
});

// Startup recovery - mark stale pending as failed then enqueue pending jobs
(async () => {
  try {
    await markStalePendingAsFailed();
    await enqueuePendingStockItemJobs();
  } catch (error) {
    console.error(
      "Stock item startup recovery failed:",
      error.message
    );
  }
})();

console.log(
  "Push Stock Item BullMQ Worker Started"
);

export default worker;