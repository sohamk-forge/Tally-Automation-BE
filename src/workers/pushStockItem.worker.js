import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { STOCK_ITEM_QUEUE_NAME } from "../queues/stockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { getStockItemCreateXML } from "../services/pushXmlBuilder.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryStockItemError(error) {
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

async function markStalePendingAsFailed() {
  const result = await pool.query(
    `
    UPDATE ${DB_SCHEMA}.push_stock_item
    SET
      status = 'failed',
      last_error = 'Upload interrupted / Worker restarted',
      updated_at = NOW()
    WHERE status = 'pending'
      AND updated_at < NOW() - INTERVAL '5 minutes'
    RETURNING id
    `
  );

  console.log(`Marked ${result.rowCount} stale pending stock items as failed`);
}

markStalePendingAsFailed().catch((err) => {
  console.error("Failed to mark stale pending stock items:", err.message);
});

const worker = new Worker(
  STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { stockItemId } = job.data;

    console.log(`Processing stock item ID ${stockItemId}`);

    const result = await pool.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.push_stock_item
      WHERE id = $1
      `,
      [stockItemId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Stock item ${stockItemId} not found`);
    }

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.push_stock_item
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [stockItemId]
    );

    try {
      // ─────────────────────────────────────────────────────────────
      // STEP 1: CHECK IF PARENT GROUP EXISTS
      // ─────────────────────────────────────────────────────────────

      console.log(`🔍 Checking parent group: ${row.parent_group}`);

      let parentGroupExists = await pool.query(
        `
        SELECT 1
        FROM ${DB_SCHEMA}.stock_group_summary
        WHERE company_id = $1
        AND LOWER(TRIM(group_name)) = LOWER(TRIM($2))
        LIMIT 1
        `,
        [row.company_id, row.parent_group]
      );

      // ─────────────────────────────────────────────────────────────
      // STEP 2: IF NOT FOUND → SYNC STOCK GROUPS
      // ─────────────────────────────────────────────────────────────

      if (!parentGroupExists.rows.length) {
        console.log(`🔄 Parent group not found, syncing...`);

        const syncResponse = await fetch(
          `${BASE_URL}/api/sync/stock-group-summary-sync?company=${encodeURIComponent(row.company_name)}`
        );

        if (!syncResponse.ok) {
          throw new Error("Stock group sync failed");
        }

        const syncResult = await syncResponse.json();

        if (syncResult.status !== "success") {
          throw new Error(syncResult.message || "Stock group sync failed");
        }

        console.log("✅ Stock group sync complete");

        // ─────────────────────────────────────────────────────────────
        // STEP 3: CHECK AGAIN AFTER SYNC
        // ─────────────────────────────────────────────────────────────

        parentGroupExists = await pool.query(
          `
          SELECT 1
          FROM ${DB_SCHEMA}.stock_group_summary
          WHERE company_id = $1
          AND LOWER(TRIM(group_name)) = LOWER(TRIM($2))
          LIMIT 1
          `,
          [row.company_id, row.parent_group]
        );
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 4: IF STILL NOT FOUND → FAIL
      // ─────────────────────────────────────────────────────────────

      if (!parentGroupExists.rows.length) {
        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.push_stock_item
          SET
            status = 'failed',
            last_error = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [`Parent group not found: ${row.parent_group}`, stockItemId]
        );
        console.log(`❌ Parent Group Not Found: ${row.parent_group}`);
        return { stockItemId, status: 'failed', error: 'Parent group not found' };
      }

      console.log(`✅ Parent Group Validated: ${row.parent_group}`);

      // ─────────────────────────────────────────────────────────────
      // STEP 5: GENERATE XML ✅
      // ─────────────────────────────────────────────────────────────

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

      console.log(`📤 Stock item XML generated: ${row.item_name}`);

      // ─────────────────────────────────────────────────────────────
      // STEP 6: GET CONNECTOR PAIRING
      // ─────────────────────────────────────────────────────────────

      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM ${DB_SCHEMA}.companies c
        JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
          ON c.id = cpt.company_id
        WHERE c.id = $1
        `,
        [row.company_id]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for stock item ${stockItemId}`);
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 7: CREATE CONNECTOR JOB ✅
      // ─────────────────────────────────────────────────────────────

      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'stock_item',
        requestXml: xml,
        payload: {
          stock_item_id: stockItemId,
          company_id: row.company_id,
          item_name: row.item_name
        }
      });

      // ─────────────────────────────────────────────────────────────
      // STEP 8: MARK AS PENDING (WAITING FOR CONNECTOR)
      // ─────────────────────────────────────────────────────────────

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_stock_item
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = $1
        `,
        [stockItemId]
      );

      console.log(`✅ Stock item job created for connector: ${row.item_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        stockItemId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Stock item failed: ${row.item_name}`, error.message);

      if (isTemporaryStockItemError(error)) {
        // Mark as pending for retry
        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.push_stock_item
          SET
            status = 'pending',
            last_error = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [error.message, stockItemId]
        );

        throw error;  // Let Bull retry
      }

      // Permanent failure
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_stock_item
        SET
          status = 'failed',
          last_error = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
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
  console.log(`✅ Stock item job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Stock item job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { stockItemId } = job.data;

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.push_stock_item
      SET
        status = 'failed',
        last_error = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [error.message, stockItemId]
    );

    console.error(`Stock item final failure recorded: ${stockItemId}`);
  } catch (updateError) {
    console.error(`Stock item final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Stock item worker error:", error.message);
});

console.log("✅ Push Stock Item BullMQ worker started (using Connector)");

export default worker;
