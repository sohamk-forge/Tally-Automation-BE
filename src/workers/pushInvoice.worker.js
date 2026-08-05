console.log("🚀 pushInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { PURCHASE_QUEUE_NAME } from "../queues/purchase.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
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
    message.includes("socket hang up")
  );
}

const worker = new Worker(
  PURCHASE_QUEUE_NAME,
  async (job) => {
    const { invoiceId, userId } = job.data;

    if (!invoiceId) {
      throw new Error("invoiceId is required");
    }

    if (!userId) {
      throw new Error(`Missing userId for purchase invoice ${invoiceId}`);
    }

    console.log(`Processing purchase invoice ID ${invoiceId} requested by user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM app_test.invoice_extractions WHERE id = $1`,
      [invoiceId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    await pool.query(
      `UPDATE app_test.invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [invoiceId]
    );

    try {
      const mappingResult = await pool.query(
        `SELECT * FROM app_test.company_ledger_mappings WHERE company_id = $1`,
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

      const invoice = typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

      const xml = await generateXml({
        ...invoice,

        company: row.company_name,

        vendor_name: invoice.customer_name || invoice.vendor_name || "",
        vendor_gstin: invoice.gstin || invoice.vendor_gstin || "",

        purchase_ledger: mapping.purchase_ledger,

        line_items: (invoice.line_items || []).map(item => ({
          ...item,
          unit: item.unit || ""
        })),

        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger,

        reference_date: row.invoice_date,
        reference_number: row.invoice_no,
        voucher_type: "Purchase Invoice"
      });

      console.log(`📤 Purchase invoice XML generated: ${row.invoice_no}`);
      console.log(`🔍 XML:\n${xml}`);

      const connector = await resolveConnectorForCompany(
        row.company_id,
        userId
      );

      if (!connector) {
        throw new Error(
          `No active connector found for company ${row.company_id} and user ${userId}`
        );
      }

      console.log(
        `🔗 Purchase invoice connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: 'purchase_invoice',
        requestXml: xml,
        payload: {
          invoice_id: invoiceId,
          company_id: row.company_id,
          invoice_no: row.invoice_no,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `
        UPDATE app_test.invoice_extractions
        SET
          sync_status = 'pending',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [invoiceId]
      );

      console.log(`✅ Purchase invoice job created for connector: ${row.invoice_no}`, {
        jobId: connectorJob.id,
        actingUserId: userId,
        connectorUserId: connector.user_id
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
          `UPDATE app_test.invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, invoiceId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
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
      `UPDATE app_test.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
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