console.log("🚀 pushInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { PURCHASE_QUEUE_NAME } from "../queues/purchase.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { generateXml } from "../services/xmlGenerator.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporaryInvoiceError(error) {
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
    message.includes("etimedout") ||
    message.includes("ledger sync failed") ||
    message.includes("stock item sync failed")
  );
}

const worker = new Worker(
  PURCHASE_QUEUE_NAME,
  async (job) => {
    const { invoiceId } = job.data;

    console.log(`Processing purchase invoice ID ${invoiceId}`);

    // STEP 1: GET INVOICE FROM DB
    const result = await pool.query(
      `SELECT * FROM ${DB_SCHEMA}.invoice_extractions WHERE id = $1`,
      [invoiceId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [invoiceId]
    );

    try {
      // STEP 3A: FETCH LEDGER MAPPING ✅
      const mappingResult = await pool.query(
        `SELECT * FROM ${DB_SCHEMA}.company_ledger_mappings WHERE company_id = $1`,
        [row.company_id]
      );

      const mapping = mappingResult.rows[0];
      if (!mapping) {
        throw new Error(`Ledger mapping not configured for company ${row.company_id}`);
      }

      console.log(`📋 Ledger mapping loaded for company ${row.company_id}:`, {
        purchase_ledger: mapping.purchase_ledger,
        invoice_parent_group: mapping.invoice_parent_group,
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger
      });

      // STEP 3B: PARSE INVOICE DATA
      const invoice = typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

      // STEP 3C: GENERATE XML WITH ALL FIXES ✅
      const xml = await generateXml({
        ...invoice,

        // ✅ Company
        company: row.company_name,

        // ✅ Fix Bug 2: Python expects "vendor_name" but invoice has "customer_name"
        vendor_name: invoice.customer_name || invoice.vendor_name || "",
        vendor_gstin: invoice.gstin || invoice.vendor_gstin || "",

        // ✅ Fix Bug 1: Use purchase_ledger from mapping (actual ledger, not group!)
        purchase_ledger: mapping.purchase_ledger,

        // ✅ Fix Bug 3: Pass unit from item (no hardcoding!)
        line_items: (invoice.line_items || []).map(item => ({
          ...item,
          unit: item.unit || ""
        })),

        // ✅ Tax ledgers from mapping
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger,

        // ✅ Reference fields
        reference_date: row.invoice_date,
        reference_number: row.invoice_no,
        voucher_type: "Purchase Invoice"
      });

      console.log(`📤 Purchase invoice XML generated: ${row.invoice_no}`);

      // STEP 4: GET CONNECTOR PAIRING
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM ${DB_SCHEMA}.invoice_extractions ie
        JOIN ${DB_SCHEMA}.companies c
          ON ie.company_id = c.id
        JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt
          ON c.id = cpt.company_id
        WHERE ie.id = $1
        `,
        [invoiceId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for invoice ${invoiceId}`);
      }

      // STEP 5: CREATE CONNECTOR JOB
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'purchase_invoice',
        requestXml: xml,
        payload: {
          invoice_id: invoiceId,
          company_id: row.company_id,
          invoice_no: row.invoice_no
        }
      });

      // STEP 6: MARK AS PENDING
      await pool.query(
        `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [invoiceId]
      );

      console.log(`✅ Purchase invoice job created for connector: ${row.invoice_no}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        invoiceId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Purchase invoice failed: ${row.invoice_no}`, error.message);

      if (isTemporaryInvoiceError(error)) {
        await pool.query(
          `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, invoiceId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, invoiceId]
      );

      return {
        invoiceId,
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
  console.log(`✅ Purchase invoice job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Purchase invoice job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { invoiceId } = job.data;
    await pool.query(
      `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, invoiceId]
    );
    console.error(`Purchase invoice final failure recorded: ${invoiceId}`);
  } catch (updateError) {
    console.error(`Purchase invoice final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Purchase invoice worker error:", error.message);
});

console.log("✅ Push Purchase Invoice BullMQ worker started (using Connector)");

export default worker;
