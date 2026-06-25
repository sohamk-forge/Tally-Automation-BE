import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const BULK_STOCK_ITEM_QUEUE_NAME =
  "bulk-stock-item-queue";

export const bulkStockItemQueue =
  new Queue(BULK_STOCK_ITEM_QUEUE_NAME, {
    connection
  });

export const BULK_STOCK_ITEM_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 100,
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 5000
  }
};

export const getBulkStockItemJobId = (
  batchId
) => `bulk-stock-item-${batchId}`;