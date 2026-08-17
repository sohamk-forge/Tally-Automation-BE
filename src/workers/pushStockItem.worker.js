import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { STOCK_ITEM_QUEUE_NAME, safeEnqueueStockItem } from "../queues/stockItem.queue.js";
import { safeEnqueueAlterStockItem } from "../queues/alterStockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
import { getStockItemCreateXML } from "../services/pushXmlBuilder.js";

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`;

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
    message.includes("no active connector") ||
    message.includes("tally server unavailable") ||
    message.includes("server unavailable") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up")
  );
}

const worker = new Worker(
  STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { stockItemId } = job.data;

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

    // Read from the row, not job.data — startup recovery re-enqueues with
    // just { stockItemId }, no rich job payload, so the row is the source
    // of truth for who requested this push.
    const userId = row.user_id;

    if (!userId) {
      throw new Error(`Missing user_id for stock item ${stockItemId}`);
    }

    console.log(
      `Processing stock item ID ${stockItemId} requested by user ${userId}`
    );

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
      //
      // ⚠️ KNOWN ISSUE (untested after the auth rollout):
      // This is an internal HTTP call with NO Authorization header. Now that
      // authMiddleware is applied to the sync routes, this will likely return
      // 401/403, which fails every stock item whose parent group is not yet
      // present in stock_group_summary. Fix by either passing a service token
      // or calling the sync function in-process instead of over HTTP.
      // Test explicitly with a parent group that does not exist locally.
      // ─────────────────────────────────────────────────────────────

      if (!parentGroupExists.rows.length) {
        console.log(`🔄 Parent group not found, syncing...`);

        const syncResponse = await fetch(
          `${BASE_URL}/api/sync/stock-group-summary-sync?company=${encodeURIComponent(row.company_name)}`
        );

        if (!syncResponse.ok) {
          throw new Error(
            `Stock group sync failed (HTTP ${syncResponse.status})`
          );
        }

        // ✅ VALIDATE JSON RESPONSE (check application-level success)
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
      //
      // ⚠️ TODO: applicableFrom is hardcoded to 2025-04-01. The active company
      // is "(from 1-Apr-26)", so this is very likely wrong — derive it from the
      // company's financial year instead of a literal.
      //
      // ⚠️ TODO: row.opening_quantity / opening_rate / opening_value exist on
      // push_stock_item but are never sent to Tally. If the UI collects opening
      // stock, it is being stored and silently dropped.
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
      // STEP 6: RESOLVE CONNECTOR FOR THIS COMPANY
      // ─────────────────────────────────────────────────────────────
      //
      // Routed by company, not strictly by the requesting user — multiple
      // users can share one company's Tally/connector. userId is passed
      // through so resolveConnectorForCompany() can prefer that user's own
      // connector if it's online, but it is not a hard requirement for
      // routing to succeed. requested_by_user_id is still recorded on the
      // connector job below for audit trail.
      // ─────────────────────────────────────────────────────────────

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
        `🔗 Stock item connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      // ─────────────────────────────────────────────────────────────
      // STEP 7: CREATE CONNECTOR JOB ✅
      // ─────────────────────────────────────────────────────────────

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: "stock_item",
        requestXml: xml,
        payload: {
          stock_item_id: stockItemId,
          company_id: row.company_id,
          item_name: row.item_name,
          requested_by_user_id: userId
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
        actingUserId: userId,
        connectorUserId: connector.user_id
      });

      return {
        stockItemId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(
        `❌ Stock item failed: ${row.item_name}`,
        error.message
      );

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
          [
            error.message,
            stockItemId
          ]
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
        [
          error.message,
          stockItemId
        ]
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
  console.log(
    `✅ Stock item job completed: ${job.id}`,
    job.returnvalue
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `❌ Stock item job failed: ${job?.id}`,
    error.message
  );

  if (!job) return;

  const maximumAttempts =
    Number(job.opts.attempts || 1);

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
      [
        error.message,
        stockItemId
      ]
    );

    console.error(`Stock item final failure recorded: ${stockItemId}`);
  } catch (updateError) {
    console.error(
      `Stock item final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "❌ Stock item worker error:",
    error.message
  );
});

/*
====================================
STARTUP RECOVERY

Mirrors pushBank.worker.js / pushVoucher.worker.js's recovery pair.
push_stock_item is shared by two independent flows — "create" (this file,
bulkStockItem.worker.js) and "alter" (pushAlterStockItem.worker.js,
triggered from pushStockItemOpening.routes.js and the auto-chain in
connector.routes.js) — both leave a row at status 'pending' with no job
ever created for it if the process dies between the DB write and the
Redis enqueue call. pending_job_type records which queue a stuck row
belongs to, so recovery re-enqueues to the correct one instead of guessing.
Runs once here (not duplicated in pushAlterStockItem.worker.js) since both
workers load into the same process.
====================================
*/

async function markStalePendingStockItemsAsFailed() {
  const result = await pool.query(
    `UPDATE ${DB_SCHEMA}.push_stock_item
     SET
       status = 'failed',
       last_error = 'Upload interrupted / worker restarted',
       updated_at = NOW()
     WHERE status = 'pending'
       AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending stock items as failed`);
}

async function enqueuePendingStockItemJobs() {
  const result = await pool.query(
    `SELECT id, user_id, pending_job_type FROM ${DB_SCHEMA}.push_stock_item
     WHERE status = 'pending'
     ORDER BY id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    if (!row.user_id) continue; // pre-migration row — no safe way to attribute it, leave for manual cleanup

    const { action } = row.pending_job_type === "alter"
      ? await safeEnqueueAlterStockItem(row.id, row.user_id)
      : await safeEnqueueStockItem(row.id, row.user_id);

    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending stock item jobs (rest already queued/active)`);
}

(async () => {
  try {
    await markStalePendingStockItemsAsFailed();
    await enqueuePendingStockItemJobs();
  } catch (error) {
    console.error("Stock item startup recovery failed:", error.message);
  }
})();

console.log(
  "✅ Push Stock Item BullMQ worker started (using Connector)"
);

export default worker;