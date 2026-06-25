// =========================================
// src/workers/pushOdBank.worker.js
// =========================================

import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import {
  odBankQueue,
  OD_BANK_JOB_OPTIONS,
  OD_BANK_QUEUE_NAME,
  getOdBankJobId
} from "../queues/odBank.queue.js";
import {
  sendToTally
} from "../services/tallyClient.js";
import {
  createOdBankXML
} from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// ADDED: Temporary error detection function
function isTemporaryOdBankError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
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
    message.includes("etimedout");
}

async function enqueuePendingOdBankJobs() {
  const result = await pool.query(
    `
    SELECT id
    FROM app_test.bank_od_accounts
    WHERE sync_status = 'pending'
    ORDER BY id ASC
    `
  );

  for (const row of result.rows) {
    const jobId = getOdBankJobId(row.id);
    const existingJob = await odBankQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
      const isProcessable = [
        "waiting",
        "active",
        "delayed",
        "prioritized",
        "paused",
        "waiting-children"
      ].includes(state);

      if (isProcessable) {
        continue;
      }

      await existingJob.remove();
    }

    await odBankQueue.add(
      "push-od-bank",
      { odBankId: row.id },
      {
        ...OD_BANK_JOB_OPTIONS,
        jobId
      }
    );
  }
}

const worker = new Worker(
  OD_BANK_QUEUE_NAME,
  async (job) => {
    const { odBankId } = job.data;

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.bank_od_accounts
      WHERE id = $1
      `,
      [odBankId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        `OD/OCC ledger ${odBankId} not found`
      );
    }

    try {
      console.log(
        `PUSHING OD/OCC: ${row.ledger_name}`
      );
      console.log(
        "ACCOUNT TYPE FROM DB:",
        row.account_type
      );
      const xml = createOdBankXML({
        company:
          row.company_name,
        ledger_name:
          row.ledger_name,
        account_type:
          row.account_type,
        opening_balance:
          row.opening_balance,
        od_limit:
          row.od_limit,
        bank_name:
          row.bank_name,
        branch_name:
          row.branch_name,
        account_holder:
          row.account_holder,
        account_number:
          row.account_number,
        ifsc_code:
          row.ifsc_code,
        swift_code:
          row.swift_code,
        address:
          row.address,
        state:
          row.state,
        country:
          row.country,
        pincode:
          row.pincode,
        contact_person:
          row.contact_person,
        mobile:
          row.mobile,
        email:
          row.email
      });
      console.log(
        "FULL ROW:",
        row
      );

      const tallyResponse =
        await sendToTally(xml);

      console.log(
        "RAW XML RESPONSE:\n",
        tallyResponse
      );

      const createdMatch =
        tallyResponse.match(
          /<CREATED>(\d+)<\/CREATED>/
        );

      const created =
        createdMatch
          ? Number(createdMatch[1])
          : 0;

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );

      const altered =
        alteredMatch
          ? Number(alteredMatch[1])
          : 0;

      // REPLACED: Success check with LINEERROR extraction
      const lineErrorMatch =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        );

      const lineError =
  lineErrorMatch
    ? lineErrorMatch[1].trim()
    : null;

      const isSuccess =
        created === 1 ||
        altered === 1;

      if (!isSuccess) {
        const errorMessage =
          lineError ||
          "Tally push failed";

        await pool.query(
          `
          UPDATE app_test.bank_od_accounts
          SET
            sync_status = 'failed',
            tally_response = $1,
            error_message = $2,
            updated_at = NOW()
          WHERE id = $3
          `,
          [
            tallyResponse,
            errorMessage,
            odBankId
          ]
        );

        return {
          odBankId,
          status: "failed"
        };
      }

      await pool.query(
        `
        UPDATE app_test.bank_od_accounts
        SET
          sync_status = 'success',
          tally_response = $1,
          error_message = NULL,
          synced_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          tallyResponse,
          odBankId
        ]
      );

      console.log(
        `SUCCESS: ${row.ledger_name}`
      );

      return { odBankId };
      
    // REPLACED: Entire catch block
    } catch (error) {
      console.log(
        `OD/OCC ATTEMPT FAILED: ${row.ledger_name}`
      );

      console.log(error.message);

      if (isTemporaryOdBankError(error)) {
        await pool.query(
          `
          UPDATE app_test.bank_od_accounts
          SET
            sync_status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            odBankId
          ]
        );

        throw error;
      }

      await pool.query(
        `
        UPDATE app_test.bank_od_accounts
        SET
          sync_status = 'failed',
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
    `OD/OCC job completed: ${job.id}`
  );
});

// REPLACED: Entire worker.on("failed") block
worker.on("failed", async (job, error) => {
  console.error(
    `OD/OCC job failed: ${job?.id}`,
    error.message
  );

  if (!job) {
    return;
  }

  const maximumAttempts =
    Number(job.opts.attempts || 1);

  if (job.attemptsMade < maximumAttempts) {
    return;
  }

  try {
    const { odBankId } = job.data;

    await pool.query(
      `
      UPDATE app_test.bank_od_accounts
      SET
        sync_status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        odBankId
      ]
    );
  } catch (updateError) {
    console.error(
      `OD/OCC final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "OD/OCC worker error:",
    error.message
  );
});

enqueuePendingOdBankJobs().catch((error) => {
  console.error(
    "OD/OCC startup recovery failed:",
    error.message
  );
});

console.log(
  "Push OD/OCC BullMQ Worker Started"
);

export default worker;