console.log("🚀 pushSalesInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { SALES_QUEUE_NAME } from "../queues/sales.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { generateSalesXml } from "../services/xmlGenerator.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporarySalesError(error) {
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
  SALES_QUEUE_NAME,
  async (job) => {
    const { salesId } = job.data;

    console.log(`Processing sales invoice ID ${salesId}`);

    // STEP 1: GET SALES INVOICE FROM DB
    const result = await pool.query(
      `SELECT * FROM app_test.sales_invoice_extractions WHERE id = $1`,
      [salesId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Sales invoice ${salesId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE app_test.sales_invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [salesId]
    );

    try {
      // STEP 3A: FETCH SALES LEDGER MAPPING ✅
      const mappingResult = await pool.query(
        `SELECT * FROM app_test.company_ledger_mappings WHERE company_id = $1`,
        [row.company_id]
      );

      const mapping = mappingResult.rows[0];
      if (!mapping) {
        throw new Error(`Ledger mapping not configured for company ${row.company_id}`);
      }

      console.log(`📋 Sales ledger mapping loaded for company ${row.company_id}:`, {
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger
      });

      // STEP 3B: PARSE INVOICE DATA
      const invoice = typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

      // STEP 3C: GENERATE XML ✅
      const xml = await generateSalesXml({
        ...invoice,
        company: row.company_name,

        // ✅ Tax ledgers from mapping
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger,

        // ✅ Reference fields
        reference_date: row.invoice_date,
        reference_number: row.invoice_no,
        voucher_type: "Sales Invoice"
      });

      console.log(`📤 Sales invoice XML generated: ${row.invoice_no}`);

      // STEP 4: GET CONNECTOR PAIRING
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.sales_invoice_extractions sie
        JOIN app_test.companies c
          ON sie.company_id = c.id
        JOIN app_test.connector_pairing_tokens cpt
          ON c.id = cpt.company_id
        WHERE sie.id = $1
        `,
        [salesId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for sales invoice ${salesId}`);
      }

      // STEP 5: CREATE CONNECTOR JOB
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'sales_invoice',
        requestXml: xml,
        payload: {
          invoice_id: salesId,
          company_id: row.company_id,
          invoice_no: row.invoice_no
        }
      });

      // STEP 6: MARK AS PENDING
      await pool.query(
        `UPDATE app_test.sales_invoice_extractions SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [salesId]
      );

      console.log(`✅ Sales invoice job created for connector: ${row.invoice_no}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        salesId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Sales invoice failed: ${row.invoice_no}`, error.message);

      if (isTemporarySalesError(error)) {
        await pool.query(
          `UPDATE app_test.sales_invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, salesId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, salesId]
      );

      return {
        salesId,
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
  console.log(`✅ Sales invoice job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Sales invoice job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { salesId } = job.data;
    await pool.query(
      `UPDATE app_test.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, salesId]
    );
    console.error(`Sales invoice final failure recorded: ${salesId}`);
  } catch (updateError) {
    console.error(`Sales invoice final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Sales invoice worker error:", error.message);
});

console.log("✅ Push Sales Invoice BullMQ worker started (using Connector)");

export default worker;