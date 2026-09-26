// queues/bulkSales.queue.js

import { Queue } from "bullmq";
import IORedis from "ioredis";

export const BULK_SALES_QUEUE_NAME =
  "bulk-sales";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const bulkSalesQueue =
  new Queue(
    BULK_SALES_QUEUE_NAME,
    { connection }
  );

export const BULK_SALES_JOB_OPTIONS = {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 1000
};

export function getBulkSalesJobId(
  batchId
) {
  return `bulk-sales-${batchId}`;
}