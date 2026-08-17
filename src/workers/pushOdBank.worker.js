import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { OD_BANK_QUEUE_NAME, safeEnqueueOdBank } from "../queues/odBank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
import { createOdBankXML } from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryOdBankError(error) {
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
  OD_BANK_QUEUE_NAME,
  async (job) => {
    const { odBankId } = job.data;

    if (!odBankId) {
      throw new Error("odBankId is required");
    }

    const result = await pool.query(
      `SELECT * FROM app_test.bank_od_accounts WHERE id = $1`,
      [odBankId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`OD/OC bank ${odBankId} not found`);
    }

    // Read from the row, not job.data — startup recovery re-enqueues with
    // just { odBankId }, no rich job payload, so the row is the source of
    // truth for who requested this push.
    const userId = row.user_id;

    if (!userId) {
      throw new Error(`Missing user_id for OD/OC bank ${odBankId}`);
    }

    console.log(
      `Processing OD/OC bank ID ${odBankId} requested by user ${userId}`
    );

    await pool.query(
      `UPDATE app_test.bank_od_accounts SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [odBankId]
    );

    try {
      const xml = createOdBankXML({
        company: row.company_name,
        ledger_name: row.ledger_name,
        parent: row.parent_group || "Bank OD A/c",
        opening_balance: row.opening_balance,
        bank_name: row.bank_name,
        branch_name: row.branch_name,
        account_holder: row.account_holder,
        account_number: row.account_number,
        ifsc_code: row.ifsc_code,
        swift_code: row.swift_code,
        od_limit: row.od_limit,
        address: row.address,
        state: row.state,
        country: row.country || "India",
        pincode: row.pincode,
        contact_person: row.contact_person,
        mobile: row.mobile,
        email: row.email
      });

      console.log(`📤 OD/OC bank XML generated: ${row.bank_name}`);

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
        `🔗 OD/OC Bank connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: 'odbank',
        requestXml: xml,
        payload: {
          odbank_id: odBankId,
          company_id: row.company_id,
          bank_name: row.bank_name,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `
        UPDATE app_test.bank_od_accounts
        SET
          sync_status = 'pending',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [odBankId]
      );

      console.log(
        `✅ OD/OC bank job created for connector: ${row.bank_name}`,
        {
          jobId: connectorJob.id,
          actingUserId: userId,
          connectorUserId: connector.user_id
        }
      );

      return {
        odBankId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ OD/OC bank failed: ${row.bank_name}`, error.message);

      if (isTemporaryOdBankError(error)) {
        await pool.query(
          `UPDATE app_test.bank_od_accounts SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, odBankId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.bank_od_accounts SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, odBankId]
      );

      return {
        odBankId,
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
  console.log(`✅ OD/OC bank job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ OD/OC bank job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { odBankId } = job.data;
    await pool.query(
      `UPDATE app_test.bank_od_accounts SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, odBankId]
    );
    console.error(`OD/OC bank final failure recorded: ${odBankId}`);
  } catch (updateError) {
    console.error(`OD/OC bank final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ OD/OC bank worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY

Mirrors pushBank.worker.js's recovery pair — see that file for the full
rationale. bank_od_accounts inserts the row and enqueues the BullMQ job as
two separate steps; if the process dies in between, the row is left at
sync_status 'pending' with no job ever created for it, silently, forever.
====================================
*/

async function markStalePendingOdBankAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.bank_od_accounts
     SET
       sync_status = 'failed',
       error_message = 'Upload interrupted / worker restarted',
       updated_at = NOW()
     WHERE sync_status = 'pending'
       AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending OD/OC bank pushes as failed`);
}

async function enqueuePendingOdBankJobs() {
  const result = await pool.query(
    `SELECT id, user_id FROM app_test.bank_od_accounts
     WHERE sync_status = 'pending'
     ORDER BY id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    if (!row.user_id) continue; // pre-migration row — no safe way to attribute it, leave for manual cleanup
    const { action } = await safeEnqueueOdBank(row.id, row.user_id);
    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending OD/OC bank jobs (rest already queued/active)`);
}

(async () => {
  try {
    await markStalePendingOdBankAsFailed();
    await enqueuePendingOdBankJobs();
  } catch (error) {
    console.error("OD/OC bank startup recovery failed:", error.message);
  }
})();

console.log("✅ Push OD/OC Bank BullMQ worker started (using Connector)");

export default worker;