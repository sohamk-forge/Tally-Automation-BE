import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { BANK_QUEUE_NAME, safeEnqueueBank } from "../queues/bank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
import { createBankLedgerXML } from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryBankError(error) {
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
  BANK_QUEUE_NAME,
  async (job) => {
    const { bankId } = job.data;

    if (!bankId) {
      throw new Error("bankId is required");
    }

    const result = await pool.query(
      `SELECT * FROM app_test.push_bank WHERE id = $1`,
      [bankId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Bank ${bankId} not found`);
    }

    // Read from the row, not job.data — startup recovery re-enqueues with
    // just { bankId }, no rich job payload, so the row is the source of
    // truth for who requested this push.
    const userId = row.user_id;

    if (!userId) {
      throw new Error(`Missing user_id for bank ${bankId}`);
    }

    console.log(`Processing bank ID ${bankId} requested by user ${userId}`);

    await pool.query(
      `UPDATE app_test.push_bank SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [bankId]
    );

    try {
      const xml = createBankLedgerXML({
        company: row.company_name,
        ledger_name: row.ledger_name,
        parent: row.parent_group || "Bank Accounts",
        opening_balance: row.opening_balance,
        bank_name: row.bank_name,
        branch_name: row.branch_name,
        account_holder: row.account_holder,
        account_number: row.account_number,
        ifsc_code: row.ifsc_code,
        swift_code: row.swift_code,
        address: row.address,
        state: row.state,
        country: row.country || "India",
        pincode: row.pincode,
        contact_person: row.contact_person,
        mobile: row.mobile,
        email: row.email
      });

      console.log(`📤 Bank XML generated: ${row.bank_name}`);

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
        `🔗 Bank connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: 'bank',
        requestXml: xml,
        payload: {
          bank_id: bankId,
          company_id: row.company_id,
          bank_name: row.bank_name,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `
        UPDATE app_test.push_bank
        SET
          sync_status = 'pending',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [bankId]
      );

      console.log(`✅ Bank job created for connector: ${row.bank_name}`, {
        jobId: connectorJob.id,
        actingUserId: userId,
        connectorUserId: connector.user_id
      });

      return {
        bankId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Bank failed: ${row.bank_name}`, error.message);

      if (isTemporaryBankError(error)) {
        await pool.query(
          `UPDATE app_test.push_bank SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, bankId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.push_bank SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, bankId]
      );

      return {
        bankId,
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
  console.log(`✅ Bank job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Bank job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { bankId } = job.data;
    await pool.query(
      `UPDATE app_test.push_bank SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, bankId]
    );
    console.error(`Bank final failure recorded: ${bankId}`);
  } catch (updateError) {
    console.error(`Bank final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Bank worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY

Mirrors pushVoucher.worker.js's recovery pair. pushBank.routes.js inserts
the row and enqueues the BullMQ job as two separate steps — if the process
dies in between (e.g. a backend restart), the row is left at sync_status
'pending' with no job ever created for it, silently, forever. This runs on
every startup to self-heal that: anything stuck too long is marked failed
(can't be safely retried — too old to trust), anything recent gets a fresh
job in case it's simply missing one.
====================================
*/

async function markStalePendingBankAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.push_bank
     SET
       sync_status = 'failed',
       error_message = 'Upload interrupted / worker restarted',
       updated_at = NOW()
     WHERE sync_status = 'pending'
       AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending bank pushes as failed`);
}

async function enqueuePendingBankJobs() {
  const result = await pool.query(
    `SELECT id, user_id FROM app_test.push_bank
     WHERE sync_status = 'pending'
     ORDER BY id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    if (!row.user_id) continue; // pre-migration row — no safe way to attribute it, leave for manual cleanup
    const { action } = await safeEnqueueBank(row.id, row.user_id);
    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending bank jobs (rest already queued/active)`);
}

(async () => {
  try {
    await markStalePendingBankAsFailed();
    await enqueuePendingBankJobs();
  } catch (error) {
    console.error("Bank startup recovery failed:", error.message);
  }
})();

console.log("✅ Push Bank BullMQ worker started (using Connector)");

export default worker;