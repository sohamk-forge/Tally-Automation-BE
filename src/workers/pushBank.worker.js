import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import {
  createBankLedgerXML,
  createOdBankXML
} from "../services/pushXmlBuilder.js";
import {
  BANK_QUEUE_NAME,
  BANK_JOB_OPTIONS,
  getBankJobId,
  bankQueue
} from "../queues/bank.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

/*
====================================
TEMPORARY ERROR CHECK
Only retry for connection/network issues,
not for data/validation errors
====================================
*/
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

/*
====================================
STARTUP RECOVERY
Re-enqueue any rows stuck as 'pending'
that don't already have an active job
====================================
*/
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

    const existingJob = await bankQueue.getJob(jobId);

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

    await bankQueue.add(
      "push-bank",
      { bankId: row.id },
      {
        ...BANK_JOB_OPTIONS,
        jobId
      }
    );
  }
}

/*
====================================
WORKER
====================================
*/
const worker = new Worker(
  BANK_QUEUE_NAME,
  async (job) => {
    const { bankId } = job.data;

    const result = await pool.query(
      `SELECT * FROM app_test.push_bank WHERE id = $1`,
      [bankId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(`Bank ledger ${bankId} not found`);
    }

    try {
      console.log("");
      console.log("================================");
      console.log(`PROCESSING BANK LEDGER ID ${bankId}`);
      console.log("================================");

      const company = row.company_name;

      console.log(`Company       : ${company}`);
      console.log(`Ledger Name   : ${row.ledger_name}`);
      console.log(`Parent Group  : ${row.parent_group}`);
      console.log(`Bank Name     : ${row.bank_name}`);
      console.log(`Account No.   : ${row.account_number}`);
      console.log(`IFSC          : ${row.ifsc_code}`);

      /*
      ====================================
      STEP 1 — CHECK IF LEDGER ALREADY EXISTS IN TALLY
      (avoid duplicate create attempts)
      ====================================
      */

      const companyResult = await pool.query(
        `SELECT id FROM app_test.companies WHERE TRIM(name) = TRIM($1) LIMIT 1`,
        [company]
      );
      const companyId = companyResult.rows[0]?.id;

      if (!companyId) {
        await pool.query(
          `UPDATE app_test.push_bank
           SET sync_status = 'failed', error_message = 'Company not found', updated_at = NOW()
           WHERE id = $1`,
          [bankId]
        );
        console.log(`Company Not Found : ${company}`);
        return { bankId, status: "failed" };
      }

      const existingLedger = await pool.query(
        `SELECT 1 FROM app_test.all_ledger_details
         WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2)) LIMIT 1`,
        [companyId, row.ledger_name]
      );

      if (existingLedger.rows.length > 0) {
        await pool.query(
          `UPDATE app_test.push_bank
           SET sync_status = 'failed', error_message = 'Ledger already exists in Tally', updated_at = NOW()
           WHERE id = $1`,
          [bankId]
        );
        console.log(`Ledger Already Exists In Tally : ${row.ledger_name}`);
        return { bankId, status: "failed" };
      }

      /*
      ====================================
      STEP 2 — BUILD XML
      Use OD/OCC builder if account_type indicates
      an overdraft/cash-credit account, else standard
      bank ledger XML
      ====================================
      */

      const isOdAccount =
        row.account_type === "OD" || row.account_type === "OCC";

      const xmlPayload = {
        company,
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
        email: row.email,
        account_type: row.account_type,
        od_limit: row.od_limit
      };

      const xml = isOdAccount
        ? createOdBankXML(xmlPayload)
        : createBankLedgerXML(xmlPayload);

      console.log(`XML Generated (${isOdAccount ? "OD/OCC" : "Standard Bank"} Ledger)`);

      /*
      ====================================
      STEP 3 — PUSH TO TALLY
      ====================================
      */

      const tallyResponse = await sendToTally(xml);

      console.log("Tally Response Received");

      const lineErrorMatch = tallyResponse.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
      const lineError = lineErrorMatch ? lineErrorMatch[1].trim() : null;

      const createdMatch = tallyResponse.match(/<CREATED>(\d+)<\/CREATED>/);
      const created = createdMatch ? Number(createdMatch[1]) : 0;

      const alteredMatch = tallyResponse.match(/<ALTERED>(\d+)<\/ALTERED>/);
      const altered = alteredMatch ? Number(alteredMatch[1]) : 0;

      const isSuccess = created === 1 || altered === 1;

      if (!isSuccess) {
        const errorMessage = lineError || "Tally push failed";

        await pool.query(
          `UPDATE app_test.push_bank
           SET sync_status = 'failed', tally_response = $1, error_message = $2, updated_at = NOW()
           WHERE id = $3`,
          [tallyResponse, errorMessage, bankId]
        );

        console.log(`Bank Ledger Failed (Tally Error): ${bankId} - ${errorMessage}`);
        return { bankId, status: "failed" };
      }

      /*
      ====================================
      STEP 4 — SUCCESS
      ====================================
      */

      await pool.query(
        `UPDATE app_test.push_bank
         SET sync_status = 'success', tally_response = $1, error_message = NULL, updated_at = NOW(), synced_at = NOW()
         WHERE id = $2`,
        [tallyResponse, bankId]
      );

      console.log(`Bank Ledger Success : ${bankId}`);
      return { bankId, status: "success" };

    } catch (error) {
      console.error(`BANK ATTEMPT FAILED: ${bankId}`, error.message);

      if (isTemporaryBankError(error)) {
        await pool.query(
          `UPDATE app_test.push_bank
           SET sync_status = 'pending', error_message = NULL, updated_at = NOW()
           WHERE id = $1`,
          [bankId]
        );
        throw error; // BullMQ will retry
      }

      await pool.query(
        `UPDATE app_test.push_bank
         SET sync_status = 'failed', error_message = $1, updated_at = NOW()
         WHERE id = $2`,
        [error.message, bankId]
      );

      return { bankId, status: "failed" };
    }
  },
  {
    connection,
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  console.log(`Bank job completed: ${job.id}`);
});

worker.on("failed", async (job, error) => {
  console.error(`Bank job failed: ${job?.id}`, error.message);

  if (!job) {
    return;
  }

  const maximumAttempts = Number(job.opts.attempts || BANK_JOB_OPTIONS.attempts || 5);

  if (job.attemptsMade < maximumAttempts) {
    return; // BullMQ will retry
  }

  try {
    const { bankId } = job.data;
    await pool.query(
      `UPDATE app_test.push_bank
       SET sync_status = 'failed', error_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [error.message, bankId]
    );
  } catch (updateError) {
    console.error(`Bank final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("Bank worker error:", error.message);
});

// Enqueue any pending jobs on startup
enqueuePendingBankJobs().catch((error) => {
  console.error("Bank startup recovery failed:", error.message);
});

console.log("Push Bank BullMQ Worker Started");

export default worker;