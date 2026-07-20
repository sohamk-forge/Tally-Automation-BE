console.log("🚀 pushOdBank.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { OD_BANK_QUEUE_NAME } from "../queues/odbank.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
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

    console.log(`Processing OD/OC Bank ID ${odBankId}`);

    // STEP 1: GET OD/OC BANK FROM DB
    const result = await pool.query(
      `SELECT * FROM app_test.bank_od_accounts WHERE id = $1`,
      [odBankId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`OD/OC Bank ${odBankId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE app_test.bank_od_accounts SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [odBankId]
    );

    try {
      // STEP 3: GENERATE XML (no Tally calls here!) ✅
      const xml = createOdBankXML({
        company: row.company_name,
        ledger_name: row.ledger_name,
        account_type: row.account_type,
        opening_balance: row.opening_balance,
        od_limit: row.od_limit,
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

      console.log(`📤 OD/OC Bank XML generated: ${row.bank_name} (${row.account_type})`);

      // STEP 4: GET CONNECTOR PAIRING
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.bank_od_accounts boa
        JOIN app_test.companies c
          ON boa.company_id = c.id
        JOIN app_test.connector_pairing_tokens cpt
          ON c.id = cpt.company_id
        WHERE boa.id = $1
        `,
        [odBankId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for OD/OC Bank ${odBankId}`);
      }

      // STEP 5: CREATE CONNECTOR JOB
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'odbank',
        requestXml: xml,
        payload: {
          odbank_id: odBankId,
          company_id: row.company_id,
          bank_name: row.bank_name,
          account_type: row.account_type
        }
      });

      // STEP 6: MARK AS PENDING
      await pool.query(
        `UPDATE app_test.bank_od_accounts SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [odBankId]
      );

      console.log(`✅ OD/OC Bank job created for connector: ${row.bank_name}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id,
        accountType: row.account_type
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
      console.error(`❌ OD/OC Bank failed: ${row.bank_name}`, error.message);

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
  console.log(`✅ OD/OC Bank job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ OD/OC Bank job failed: ${job?.id}`, error.message);

  if (!job) return;
  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { odBankId } = job.data;
    await pool.query(
      `UPDATE app_test.bank_od_accounts SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, odBankId]
    );
    console.error(`OD/OC Bank final failure recorded: ${odBankId}`);
  } catch (updateError) {
    console.error(`OD/OC Bank final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ OD/OC Bank worker error:", error.message);
});

console.log("✅ Push OD/OC Bank BullMQ worker started (using Connector)");

export default worker;
