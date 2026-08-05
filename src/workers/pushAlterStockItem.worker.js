console.log("🚀 pushAlterStockItem.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { ALTER_STOCK_ITEM_QUEUE_NAME } from "../queues/alterStockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
import { getStockItemOpeningXML } from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

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
    message.includes("socket hang up")
  );
}

const worker = new Worker(
  ALTER_STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { stockItemId, userId } = job.data;

    if (!stockItemId) {
      throw new Error("stockItemId is required");
    }

    if (!userId) {
      throw new Error(`Missing userId for alter stock item ${stockItemId}`);
    }

    console.log(`Processing alter stock item ID ${stockItemId} requested by user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM app_test.push_stock_item WHERE id = $1`,
      [stockItemId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Stock item ${stockItemId} not found`);
    }

    await pool.query(
      `UPDATE app_test.push_stock_item SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [stockItemId]
    );

    try {
      const xml = getStockItemOpeningXML({
        company: row.company_name,
        itemName: row.item_name,
        unit: row.unit_name || "nos",
        openingQuantity: row.opening_quantity || 0,
        openingRate: row.opening_rate || 0,
        openingValue: row.opening_value || 0
      });

      console.log(`📤 Alter stock item XML generated: ${row.item_name}`);

      const connector = await resolveConnectorForCompany(
        row.company_id,
        userId
      );

      if (!connector) {
        throw new Error(
          `No active connector found for company ${row.company_id} and user ${userId}`
        );
      }

      console.log(
        `🔗 Alter stock item connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: 'alter_stock_item',
        requestXml: xml,
        payload: {
          alter_stock_item_id: stockItemId,
          company_id: row.company_id,
          item_name: row.item_name,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'pending', updated_at = NOW() WHERE id = $1`,
        [stockItemId]
      );

      console.log(`✅ Alter stock item job created for connector: ${row.item_name}`, {
        jobId: connectorJob.id,
        actingUserId: userId,
        connectorUserId: connector.user_id
      });

      return {
        stockItemId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Alter stock item failed: ${row.item_name}`, error.message);

      if (isTemporaryAlterStockItemError(error)) {
        await pool.query(
          `UPDATE app_test.push_stock_item SET status = 'pending', last_error = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, stockItemId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, stockItemId]
      );

      return {
        stockItemId,
        status: "failed",
        error: error.message
      };
    }
  },
  {
    connection,
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Alter stock item job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Alter stock item job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { stockItemId } = job.data;
    await pool.query(
      `UPDATE app_test.push_stock_item SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, stockItemId]
    );
    console.error(`Alter stock item final failure recorded: ${stockItemId}`);
  } catch (updateError) {
    console.error(`Alter stock item final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Alter stock item worker error:", error.message);
});

console.log("✅ Push Alter Stock Item BullMQ worker started (using Connector)");

export default worker;