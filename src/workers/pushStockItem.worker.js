import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { STOCK_ITEM_QUEUE_NAME } from "../queues/stockItem.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

const worker = new Worker(
  STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { stockItemId } = job.data;

    console.log(`Processing stock item ID ${stockItemId}`);

    console.log(`🚀 Processing stock item ID: ${stockItemId}`);

    try {
      // Get stock item
      const result = await pool.query(
        `SELECT * FROM app_test.push_stock_item WHERE id = $1`,
        [stockItemId]
      );

      const stockItem = result.rows[0];
      if (!stockItem) {
        throw new Error(`Stock item ${stockItemId} not found`);
      }

      console.log(`📦 Stock item found: ${stockItem.item_name}`);

      // Mark as processing
      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'processing' WHERE id = $1`,
        [stockItemId]
      );

      // Get company and connector pairing
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.push_stock_item psi
        JOIN app_test.companies c ON psi.company_id = c.id
        JOIN app_test.connector_pairing_tokens cpt ON c.id = cpt.company_id
        WHERE psi.id = $1
        `,
        [stockItemId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing for stock item ${stockItemId}`);
      }

      // Generate XML (your existing function)
      const xml = `<StockItem><!-- Your XML here --></StockItem>`;

      // Create connector job
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'stock_item',
        requestXml: xml,
        payload: {
          stock_item_id: stockItemId,
          company_id: stockItem.company_id,
          item_name: stockItem.item_name
        }
      });

      // Mark as pending (waiting for connector)
      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'pending' WHERE id = $1`,
        [stockItemId]
      );

      console.log(`✅ Connector job created: ${connectorJob.id}`);

      return { stockItemId, status: 'pending', jobId: connectorJob.id };

    } catch (error) {
      console.error(`❌ Error: ${error.message}`);

      // Permanent failure
      await pool.query(
        `UPDATE app_test.push_stock_item SET status = 'failed', error_message = $1 WHERE id = $2`,
        [error.message, stockItemId]
      );

      throw error;
    }
  },
  { connection, concurrency: 5 }
);

worker.on("completed", (job) => {
  console.log(`✅ Stock item job completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`❌ Stock item job failed: ${job.id} - ${error.message}`);
});

console.log("✅ Push Stock Item Worker Started (using Connector)");

export default worker;
