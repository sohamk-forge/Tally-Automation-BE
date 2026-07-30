console.log("🚀 pushAlterStockItem.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { ALTER_STOCK_ITEM_QUEUE_NAME } from "../queues/alterStockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
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

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ TODO (needs a design decision, deliberately NOT changed here):
//
// 1. STATUS COLUMN COLLISION
//    This worker and pushStockItem.worker.js both write
//    push_stock_item.status on the SAME row. Once both have run,
//    status = 'pending' does not say whether the create job or the opening
//    job is outstanding, and whichever connector result lands last
//    overwrites the other's outcome. Fix by splitting the column
//    (create_status / opening_status) or using distinct values
//    (awaiting_create / awaiting_opening).
//
// 2. CREATE → ALTER SEQUENCING
//    The create worker only marks 'pending'; the item does not exist in
//    Tally until the connector runs that job and reports back. If the route
//    enqueues this alter job at the same time as the create job, this XML
//    can reach Tally first and fail because the item is not there yet.
//    Safe: enqueue from the create job's success callback. Unsafe: enqueue
//    directly from the route. Verify which one you have.
//
// 3. PAYLOAD KEY MISMATCH
//    Create sends payload.stock_item_id, this sends
//    payload.alter_stock_item_id, both referring to push_stock_item.id.
//    Confirm the connector result handler knows both job_type values
//    ('stock_item', 'alter_stock_item') AND both payload keys.
// ─────────────────────────────────────────────────────────────────────────────

const worker = new Worker(
  ALTER_STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    // ✅ Fix: Route sends stockItemId not alterStockItemId
    const { stockItemId } = job.data;

    console.log(`Processing alter stock item ID ${stockItemId}`);

    // STEP 1: GET STOCK ITEM FROM DB ✅ (correct table: push_stock_item)
    const result = await pool.query(
      `SELECT * FROM app_test.push_stock_item WHERE id = $1`,
      [stockItemId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Stock item ${stockItemId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE app_test.push_stock_item SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [stockItemId]
    );

    try {
      // STEP 3: GENERATE XML ✅ (using getStockItemOpeningXML)
      //
      // ✅ FIXED: was row.unit, but push_stock_item has no `unit` column —
      // the column is `unit_name`. row.unit was always undefined, so every
      // opening push silently fell back to "nos" regardless of the unit the
      // user selected.
      const xml = getStockItemOpeningXML({
        company: row.company_name,
        itemName: row.item_name,
        unit: row.unit_name || "nos",
        openingQuantity: row.opening_quantity || 0,
        openingRate: row.opening_rate || 0,
        openingValue: row.opening_value || 0
      });

      console.log(`📤 Alter stock item XML generated: ${row.item_name}`);

      // STEP 4: GET CONNECTOR PAIRING ✅
      //
      // Simplified: company_id already available on `row`, so the subquery
      // back into push_stock_item is unnecessary. Matches the shape used in
      // pushBank / pushLedger / pushSalesInvoice / pushStockItem.
      //
      // ⚠️ INTERIM FIX ONLY. Deterministic, not correct: if two logins share
      // a company_id, every job for that company routes to whoever paired
      // most recently. Real fix is a user_id column on push_stock_item,
      // written from req.user.id at insert time. The candidate_count warning
      // below tells you whether that migration is urgent.
      const pairingResult = await pool.query(
        `
        SELECT user_id, COUNT(*) OVER () AS candidate_count
        FROM app_test.connector_pairing_tokens
        WHERE company_id = $1
          AND is_used = TRUE
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [row.company_id]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for stock item ${stockItemId}`);
      }

      if (Number(pairing.candidate_count) > 1) {
        console.warn(
          `⚠️ AMBIGUOUS PAIRING: company ${row.company_id} has ${pairing.candidate_count} used pairing tokens; routing alter stock item ${stockItemId} to user ${pairing.user_id}`
        );
      }

      // STEP 5: CREATE CONNECTOR JOB ✅
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'alter_stock_item',
        requestXml: xml,
        payload: {
          alter_stock_item_id: stockItemId,
          company_id: row.company_id,
          item_name: row.item_name
        }
      });

      // STEP 6: MARK AS PENDING ✅
      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'pending', updated_at = NOW() WHERE id = $1`,
        [stockItemId]
      );

      console.log(`✅ Alter stock item job created for connector: ${row.item_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
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