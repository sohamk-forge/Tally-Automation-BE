import { Queue } from "bullmq";
import IORedis from "ioredis";

export const BULK_SALES_QUEUE_NAME_V2 = "bulk-sales-v2";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const bulkSalesQueueV2 = new Queue(
  BULK_SALES_QUEUE_NAME_V2,
  { connection }
);

export const BULK_SALES_V2_JOB_OPTIONS = {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 1000
};

export function getBulkSalesV2JobId(batchId) {
  return `bulk-sales-v2-${batchId}`;
}