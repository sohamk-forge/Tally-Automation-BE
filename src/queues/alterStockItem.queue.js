import { Queue } from "bullmq";
import IORedis from "ioredis";

export const ALTER_STOCK_ITEM_QUEUE_NAME =
  "alter-stock-item-push";

export const ALTER_STOCK_ITEM_JOB_OPTIONS = {
  attempts: 5,

  backoff: {
    type: "exponential",
    delay: 5000
  },

  removeOnComplete: 100,

  removeOnFail: 100
};

export function getAlterStockItemJobId(
  stockItemId
) {
  return `alter-stock-item-${stockItemId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",

  port: Number(
    process.env.REDIS_PORT || 6379
  ),

  maxRetriesPerRequest: null
});

export const alterStockItemQueue =
  new Queue(
    ALTER_STOCK_ITEM_QUEUE_NAME,
    {
      connection
    }
  );

export default alterStockItemQueue;