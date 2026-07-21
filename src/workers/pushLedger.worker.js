import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import { LEDGER_QUEUE_NAME } from "../queues/ledger.queue.js";
import { sendToTally } from "../services/tallyClient.js";
import { createLedgerXML } from "../services/pushXmlBuilder.js";

import { DB_SCHEMA } from "../config/db.js";
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
      FROM ${DB_SCHEMA}.push_ledger
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
      UPDATE ${DB_SCHEMA}.push_ledger
      SET
        status = 'processing',
        updated_at = NOW()
      WHERE id = $1
      `,
      [ledgerId]
    );

    try {
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

      const tallyResponse = await sendToTally(xml);

      const created = Number(
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        )?.[1] || 0
      );

      const altered = Number(
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        )?.[1] || 0
      );

      const lineError =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        )?.[1] || null;

      const isSuccess =
        created === 1 || altered === 1;

      if (!isSuccess) {
        const errorMessage =
          lineError || "Tally push failed";

        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.push_ledger
          SET
            status = 'failed',
            tally_response = $1,
            error_message = $2,
            updated_at = NOW()
          WHERE id = $3
          `,
          [
            tallyResponse,
            errorMessage,
            ledgerId
          ]
        );

        return {
          ledgerId,
          status: "failed"
        };
      }

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_ledger
        SET
          status = 'success',
          tally_response = $1,
          error_message = NULL,
          sync_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          tallyResponse,
          ledgerId
        ]
      );

      console.log(
        `Ledger completed: ${row.ledger_name}`
      );

      return { ledgerId };
    } catch (error) {
      console.error(
        `Ledger failed: ${row.ledger_name}`,
        error.message
      );

      if (isTemporaryLedgerError(error)) {
        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.push_ledger
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

        throw error;
      }

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_ledger
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
        status: "failed"
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
    `Ledger job completed: ${job.id}`
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `Ledger job failed: ${job?.id}`,
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
      UPDATE ${DB_SCHEMA}.push_ledger
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
  } catch (updateError) {
    console.error(
      `Ledger final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "Ledger worker error:",
    error.message
  );
});

console.log(
  "Push Ledger BullMQ worker started"
);

export default worker;