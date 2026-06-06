import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import {
  bankQueue,
  BANK_JOB_OPTIONS,
  BANK_QUEUE_NAME,
  getBankJobId
} from "../queues/bank.queue.js";

import {
  sendToTally
} from "../services/tallyClient.js";

import {
  createBankLedgerXML
} from "../services/pushXmlBuilder.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryBankError(error) {
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

async function enqueuePendingBankJobs() {
  const result = await pool.query(
    `
    SELECT id
    FROM app_test.push_bank
    WHERE sync_status = 'pending'
    ORDER BY id ASC
    `
  );

  for (const row of result.rows) {
    const jobId = getBankJobId(row.id);

    const existingJob =
      await bankQueue.getJob(jobId);

    if (existingJob) {
      const state =
        await existingJob.getState();

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

    await bankQueue.add(
      "push-bank",
      {
        bankId: row.id
      },
      {
        ...BANK_JOB_OPTIONS,
        jobId
      }
    );
  }
}

const worker = new Worker(
  BANK_QUEUE_NAME,
  async (job) => {
    const { bankId } = job.data;

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.push_bank
      WHERE id = $1
      `,
      [bankId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        `Bank ledger ${bankId} not found`
      );
    }

    try {
      console.log(
        `PUSHING BANK: ${row.ledger_name}`
      );

      console.log(
        "COMPANY NAME:",
        row.company_name
      );

      const xml = createBankLedgerXML({
        company: row.company_name?.trim(),
        ledger_name: row.ledger_name,
        parent: row.parent_group,
        opening_balance: row.opening_balance,
        bank_name: row.bank_name,
        branch_name: row.branch_name,
        account_holder: row.account_holder,
        account_number: row.account_number,
        ifsc_code: row.ifsc_code,
        swift_code: row.swift_code,
        address: row.address,
        state: row.state,
        country: row.country,
        pincode: row.pincode,
        contact_person: row.contact_person,
        mobile: row.mobile,
        email: row.email
      });

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

      const created = createdMatch
        ? Number(createdMatch[1])
        : 0;

      const alteredMatch =
        tallyResponse.match(
          /<ALTERED>(\d+)<\/ALTERED>/
        );

      const altered = alteredMatch
        ? Number(alteredMatch[1])
        : 0;

      const lineErrorMatch =
        tallyResponse.match(
          /<LINEERROR>(.*?)<\/LINEERROR>/
        );

      const lineError = lineErrorMatch
        ? lineErrorMatch[1]
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
          UPDATE app_test.push_bank
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
            bankId
          ]
        );

        console.error(
          `BANK FAILED: ${row.ledger_name}`,
          errorMessage
        );

        return {
          bankId,
          status: "failed"
        };
      }

      await pool.query(
        `
        UPDATE app_test.push_bank
        SET
          sync_status = 'success',
          tally_response = $1,
          error_message = NULL,
          updated_at = NOW(),
          synced_at = NOW()
        WHERE id = $2
        `,
        [
          tallyResponse,
          bankId
        ]
      );

      console.log(
        `SUCCESS: ${row.ledger_name}`
      );

      return { bankId };
    } catch (error) {
      console.error(
        `BANK ATTEMPT FAILED: ${row.ledger_name}`,
        error.message
      );

      if (isTemporaryBankError(error)) {
        await pool.query(
          `
          UPDATE app_test.push_bank
          SET
            sync_status = 'pending',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            error.message,
            bankId
          ]
        );

        throw error;
      }

      await pool.query(
        `
        UPDATE app_test.push_bank
        SET
          sync_status = 'failed',
          error_message = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          bankId
        ]
      );

      return {
        bankId,
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
    `Bank job completed: ${job.id}`
  );
});

worker.on("failed", async (job, error) => {
  console.error(
    `Bank job failed: ${job?.id}`,
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
    const { bankId } = job.data;

    await pool.query(
      `
      UPDATE app_test.push_bank
      SET
        sync_status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        error.message,
        bankId
      ]
    );
  } catch (updateError) {
    console.error(
      `Bank final failure update failed: ${job.id}`,
      updateError.message
    );
  }
});

worker.on("error", (error) => {
  console.error(
    "Bank worker error:",
    error.message
  );
});

enqueuePendingBankJobs().catch((error) => {
  console.error(
    "Bank startup recovery failed:",
    error.message
  );
});

console.log(
  "Push Bank BullMQ Worker Started"
);

export default worker;