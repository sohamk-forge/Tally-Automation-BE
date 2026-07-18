import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { BANK_QUEUE_NAME } from "../queues/bank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

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
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout")
  );
}

const worker = new Worker(
  BANK_QUEUE_NAME,
  async (job) => {
    const { bankId } = job.data;

    console.log(`Processing bank ID ${bankId}`);

    const result = await pool.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.push_bank
      WHERE id = $1
      `,
      [bankId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Bank ${bankId} not found`);
    }

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.push_bank
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [bankId]
    );

    try {
      // ─────────────────────────────────────────────────────────────
      // STEP 1: Generate XML (stays in backend) ✅
      // ─────────────────────────────────────────────────────────────
      const xml = await generateBankXML(row);

      // ─────────────────────────────────────────────────────────────
      // STEP 2: Get connector pairing info for this bank's company
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
        throw new Error(`No connector pairing found for bank ${bankId}`);
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 3: Create connector job (moves Tally work to connector)
      // ─────────────────────────────────────────────────────────────
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

      // ─────────────────────────────────────────────────────────────
      // STEP 4: Mark as pending (waiting for connector result)
      // ─────────────────────────────────────────────────────────────
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_bank
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = $1
        `,
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
        // Mark as pending for retry
        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.push_bank
          SET
            status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [error.message, bankId]
        );

        throw error;  // Let Bull retry
      }

      // Permanent failure
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_bank
        SET
          status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
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

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { bankId } = job.data;

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.push_bank
      SET
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
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

// ─────────────────────────────────────────────────────────────
// Helper: Generate Bank XML (keep your original implementation)
// ─────────────────────────────────────────────────────────────
async function generateBankXML(row) {
  // Keep your original XML generation logic here
  // This is where your existing bank XML builder goes
  return `<BankXML><!-- Your original XML generation --></BankXML>`;
}

console.log("✅ Push Bank BullMQ worker started (using Connector)");

export default worker;
