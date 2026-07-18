import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import { LEDGER_QUEUE_NAME } from "../queues/ledger.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { createLedgerXML } from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryLedgerError(error) {
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
  LEDGER_QUEUE_NAME,
  async (job) => {
    const { ledgerId } = job.data;

    console.log(`Processing ledger ID ${ledgerId}`);

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.push_ledger
      WHERE id = $1
      `,
      [ledgerId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Ledger ${ledgerId} not found`);
    }

    await pool.query(
      `
      UPDATE app_test.push_ledger
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [ledgerId]
    );

    try {
      // ─────────────────────────────────────────────────────────────
      // STEP 1: Generate XML (stays in backend) ✅
      // ─────────────────────────────────────────────────────────────
      const xml = createLedgerXML({
        company: row.company_name?.trim(),
        ledger_name: row.ledger_name,
        parent: row.parent_name,
        opening_balance: row.opening_balance,
        bill_wise: row.bill_wise,
        address: row.address,
        pincode: row.pincode,
        state: row.state,
        country: row.country,
        contact_person: row.contact_person,
        phone: row.phone,
        mobile: row.mobile,
        email: row.email,
        website: row.website,
        pan: row.pan,
        gstin: row.gstin,
        gst_registration_type: row.gst_registration_type
      });

      // ─────────────────────────────────────────────────────────────
      // STEP 2: Get connector pairing info for this ledger's company
      // ─────────────────────────────────────────────────────────────
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.push_ledger pl
        JOIN app_test.companies c ON pl.company_id = c.id
        JOIN app_test.connector_pairing_tokens cpt 
 ON c.id = cpt.company_id
        WHERE pl.id = $1
        `,
        [ledgerId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(
          `No connector pairing found for ledger ${ledgerId}`
        );
      }

      // ─────────────────────────────────────────────────────────────
      // STEP 3: Create connector job (moves Tally work to connector)
      // ─────────────────────────────────────────────────────────────
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,  // ← From pairing token
        jobType: 'ledger',
        requestXml: xml,
        payload: {
          ledger_id: ledgerId,
          company_id: row.company_id,
          ledger_name: row.ledger_name
        }
      });

      // ─────────────────────────────────────────────────────────────
      // STEP 4: Mark as pending (waiting for connector result)
      // ─────────────────────────────────────────────────────────────
      await pool.query(
        `
        UPDATE app_test.push_ledger
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = $1
        `,
        [ledgerId]
      );

      console.log(`✅ Ledger job created for connector: ${row.ledger_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        ledgerId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(
        `❌ Ledger failed: ${row.ledger_name}`,
        error.message
      );

      if (isTemporaryLedgerError(error)) {
        // Mark as pending for retry
        await pool.query(
          `
          UPDATE app_test.push_ledger
          SET
            status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            ledgerId
          ]
        );

        throw error;  // Let Bull retry
      }

      // Permanent failure
      await pool.query(
        `
        UPDATE app_test.push_ledger
        SET
          status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          ledgerId
        ]
      );

      return {
        ledgerId,
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
    `✅ Ledger job completed: ${job.id}`,
    job.returnvalue
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `❌ Ledger job failed: ${job?.id}`,
    error.message
  );

  if (!job) return;

  const maximumAttempts =
    Number(job.opts.attempts || 1);

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { ledgerId } = job.data;

    await pool.query(
      `
      UPDATE app_test.push_ledger
      SET
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        ledgerId
      ]
    );

    console.error(`Ledger final failure recorded: ${ledgerId}`);
  } catch (updateError) {
    console.error(
      `Ledger final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "❌ Ledger worker error:",
    error.message
  );
});

console.log(
  "✅ Push Ledger BullMQ worker started (using Connector)"
);

export default worker;