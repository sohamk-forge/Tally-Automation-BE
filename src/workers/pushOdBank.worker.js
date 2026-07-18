import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { OD_BANK_QUEUE_NAME } from "../queues/odBank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryODBankError(error) {
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
  OD_BANK_QUEUE_NAME,
  async (job) => {
    const { odBankId } = job.data;

    console.log(`Processing OD bank ID ${odBankId}`);

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.push_odbank
      WHERE id = $1
      `,
      [odBankId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`OD bank ${odBankId} not found`);
    }

    await pool.query(
      `
      UPDATE app_test.push_odbank
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [odBankId]
    );

    try {
      // ─────────────────────────────────────────────────────────────
      // STEP 1: Generate XML (stays in backend) ✅
      // ─────────────────────────────────────────────────────────────
      const xml = await generateODBankXML(row);

      // ─────────────────────────────────────────────────────────────
      // STEP 2: Get connector pairing info for this OD bank's company
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
          `No connector pairing found for OD bank ${odBankId}`
        );
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 3: Create connector job (moves Tally work to connector)
      // ─────────────────────────────────────────────────────────────
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'odbank',
        requestXml: xml,
        payload: {
          odbank_id: odBankId,
          company_id: row.company_id,
          bank_name: row.bank_name
        }
      });

      // ─────────────────────────────────────────────────────────────
      // STEP 4: Mark as pending (waiting for connector result)
      // ─────────────────────────────────────────────────────────────
      await pool.query(
        `
        UPDATE app_test.push_odbank
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = $1
        `,
        [odBankId]
      );

      console.log(`✅ OD bank job created for connector: ${row.bank_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        odBankId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

      return {
        odBankId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(
        `❌ OD bank failed: ${row.bank_name}`,
        error.message
      );

      if (isTemporaryODBankError(error)) {
        // Mark as pending for retry
        await pool.query(
          `
          UPDATE app_test.push_odbank
          SET
            status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            odBankId
          ]
        );

        throw error;  // Let Bull retry
      }

      // Permanent failure
      await pool.query(
        `
        UPDATE app_test.push_odbank
        SET
          status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          odBankId
        ]
      );

      return {
        odBankId,
        status: "failed",
        error: error.message
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
    `✅ OD bank job completed: ${job.id}`,
    job.returnvalue
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `❌ OD bank job failed: ${job?.id}`,
    error.message
  );

  if (!job) return;
  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { odBankId } = job.data;
    await pool.query(
      `
      UPDATE app_test.push_odbank
      SET
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        odBankId
      ]
    );

    console.error(`OD bank final failure recorded: ${odBankId}`);
  } catch (updateError) {
    console.error(
      `OD bank final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "❌ OD bank worker error:",
    error.message
  );
});

// ─────────────────────────────────────────────────────────────
// Helper: Generate OD Bank XML (keep your original implementation)
// ─────────────────────────────────────────────────────────────
async function generateODBankXML(row) {
  // Keep your original XML generation logic here
  // This is where your existing OD bank XML builder goes
  return `<ODBankXML><!-- Your original XML generation --></ODBankXML>`;
}

console.log(
  "✅ Push OD Bank BullMQ worker started (using Connector)"
);

export default worker;
