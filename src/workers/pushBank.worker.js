import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { BANK_QUEUE_NAME } from "../queues/bank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
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

    console.log(`Processing bank ID ${bankId}`);

    // STEP 1: GET BANK FROM DB
    const result = await pool.query(
      `SELECT * FROM app_test.push_bank WHERE id = $1`,
      [bankId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Bank ${bankId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE app_test.push_bank SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [bankId]
    );

    try {
      // STEP 3: GENERATE XML (no Tally calls here!) ✅
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

      // STEP 4: GET CONNECTOR PAIRING
      // Fixed: query direct from connector_pairing_tokens by company_id,
      // filtered to the used token, ordered to the most recent pairing —
      // same fix already applied in pushLedger/pushSalesInvoice/pushStockItem
      // workers. The old join (push_bank -> companies ->
      // connector_pairing_tokens) had no ORDER BY/LIMIT/is_used filter, so
      // with multiple pairing tokens sharing the same company_id it could
      // return a stale user_id nondeterministically.
      const pairingResult = await pool.query(
        `
        SELECT user_id
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
        throw new Error(`No connector pairing found for bank ${bankId}`);
      }

      // STEP 5: CREATE CONNECTOR JOB (instead of calling Tally directly!) ✅
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'bank',
        requestXml: xml,
        payload: {
          bank_id: bankId,
          company_id: row.company_id,
          bank_name: row.bank_name
        }
      });

      // STEP 6: MARK AS PENDING
      await pool.query(
        `UPDATE app_test.push_bank SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [bankId]
      );

      console.log(`✅ Bank job created for connector: ${row.bank_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
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

console.log("✅ Push Bank BullMQ worker started (using Connector)");

export default worker;