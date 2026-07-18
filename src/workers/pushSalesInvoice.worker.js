import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { SALES_QUEUE_NAME } from "../queues/sales.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

const worker = new Worker(
  SALES_QUEUE_NAME,
  async (job) => {
    const { invoiceId } = job.data;

    console.log(`🚀 Processing sales invoice ID: ${invoiceId}`);

    try {
      // Get invoice
      const result = await pool.query(
        `SELECT * FROM ${DB_SCHEMA}.sales_invoice_extractions WHERE id = $1`,
        [invoiceId]
      );

      const invoice = result.rows[0];
      if (!invoice) {
        throw new Error(`Sales invoice ${invoiceId} not found`);
      }

      console.log(`📝 Invoice found: ${invoice.invoice_no}`);

      // Mark as processing
      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'processing' WHERE id = $1`,
        [invoiceId]
      );

      // Get company and connector pairing
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM ${DB_SCHEMA}.sales_invoice_extractions sie
        JOIN ${DB_SCHEMA}.companies c ON sie.company_id = c.id
        JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON c.id = cpt.company_id
        WHERE sie.id = $1
        `,
        [invoiceId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing for invoice ${invoiceId}`);
      }

      // Generate XML (your existing function)
      const xml = `<Sales><!-- Your XML here --></Sales>`;

      // Create connector job
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'sales_invoice',
        requestXml: xml,
        payload: {
          invoice_id: invoiceId,
          company_id: invoice.company_id,
          invoice_no: invoice.invoice_no
        }
      });

      // Mark as pending (waiting for connector)
      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'pending' WHERE id = $1`,
        [invoiceId]
      );

      console.log(`✅ Connector job created: ${connectorJob.id}`);

      return { invoiceId, status: 'pending', jobId: connectorJob.id };

    } catch (error) {
      console.error(`❌ Error: ${error.message}`);

      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'failed', error_message = $1 WHERE id = $2`,
        [error.message, invoiceId]
      );

      throw error;
    }
  },
  { connection, concurrency: 5 }
);

worker.on("completed", (job) => {
  console.log(`✅ Sales invoice job completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`❌ Sales invoice job failed: ${job.id} - ${error.message}`);
});

console.log("✅ Simple Sales Invoice Worker Started (using Connector)");

export default worker;
