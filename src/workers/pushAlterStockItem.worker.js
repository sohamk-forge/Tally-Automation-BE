console.log("🚀 pushAlterStockItem.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { ALTER_STOCK_ITEM_QUEUE_NAME } from "../queues/alterStockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryAlterStockItemError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
function isTemporaryAlterStockItemError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    [
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
    message.includes("etimedout")
  );
}

const worker = new Worker(
  ALTER_STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { alterStockItemId } = job.data;

    console.log(`Processing alter stock item ID ${alterStockItemId}`);

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.alter_stock_item
      WHERE id = $1
      `,
      [alterStockItemId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Alter stock item ${alterStockItemId} not found`);
    }

    await pool.query(
      `
      UPDATE app_test.alter_stock_item
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [alterStockItemId]
    );

    try {
      // ─────────────────────────────────────────────────────────────
      // STEP 1: Generate XML (stays in backend) ✅
      // ─────────────────────────────────────────────────────────────
      const xml = await generateAlterStockItemXML(row);

      // ─────────────────────────────────────────────────────────────
      // STEP 2: Get connector pairing info for this stock item's company
      // ─────────────────────────────────────────────────────────────
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.companies c
        JOIN app_test.connector_pairing_tokens cpt 
          ON c.id = cpt.company_id
        WHERE c.id = $1
        `,
        [row.company_id]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(
          `No connector pairing found for alter stock item ${alterStockItemId}`
        );
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 3: Create connector job (moves Tally work to connector)
      // ─────────────────────────────────────────────────────────────
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'alter_stock_item',
        requestXml: xml,
        payload: {
          alter_stock_item_id: alterStockItemId,
          company_id: row.company_id,
          item_name: row.item_name
        }
      });

      // ─────────────────────────────────────────────────────────────
      // STEP 4: Mark as pending (waiting for connector result)
      // ─────────────────────────────────────────────────────────────
      await pool.query(
        `
        UPDATE app_test.alter_stock_item
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = $1
        `,
        [alterStockItemId]
      );

      console.log(`✅ Alter stock item job created for connector: ${row.item_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        alterStockItemId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(
        `❌ Alter stock item failed: ${row.item_name}`,
        error.message
      );

      if (isTemporaryAlterStockItemError(error)) {
        // Mark as pending for retry
        await pool.query(
          `
          UPDATE app_test.alter_stock_item
          SET
            status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            alterStockItemId
          ]
        );

        throw error;  // Let Bull retry
      }

      // Permanent failure
      await pool.query(
        `
        UPDATE app_test.alter_stock_item
        SET
          status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          alterStockItemId
        ]
      );

      return {
        alterStockItemId,
        status: "failed",
        error: error.message
      };
    }
  },
  {
    connection,
    concurrency: 5
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  console.log(
    `✅ Alter stock item job completed: ${job.id}`,
    job.returnvalue
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `❌ Alter stock item job failed: ${job?.id}`,
    error.message
  );

  if (!job) return;

  const maximumAttempts =
    Number(job.opts.attempts || 1);

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { alterStockItemId } = job.data;

    await pool.query(
      `
      UPDATE app_test.alter_stock_item
      SET
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        alterStockItemId
      ]
    );

    console.error(`Alter stock item final failure recorded: ${alterStockItemId}`);
  } catch (updateError) {
    console.error(
      `Alter stock item final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "❌ Alter stock item worker error:",
    error.message
  );
});

// ─────────────────────────────────────────────────────────────
// Helper: Generate Alter Stock Item XML (keep your original implementation)
// ─────────────────────────────────────────────────────────────
async function generateAlterStockItemXML(row) {
  // Keep your original XML generation logic here
  // This is where your existing alter stock item XML builder goes
  return `<AlterStockItemXML><!-- Your original XML generation --></AlterStockItemXML>`;
}

console.log(
  "✅ Push Alter Stock Item BullMQ worker started (using Connector)"
);

export default worker;
