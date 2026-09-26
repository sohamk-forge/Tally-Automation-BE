import { Queue } from "bullmq";
import IORedis from "ioredis";

export const STOCK_ALERT_QUEUE_NAME =
  "stock-alert-pull";

export const STOCK_ALERT_JOB_OPTIONS = {
  attempts: 5,

  backoff: {
    type: "exponential",
    delay: 5000
  },

  removeOnComplete: 100,

  removeOnFail: 100
};

export function getStockAlertJobId(
  company
) {
  return `stock-alert-${company}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",

  port: Number(
    process.env.REDIS_PORT || 6379
  ),

  maxRetriesPerRequest: null
});

export const stockAlertQueue =
  new Queue(
    STOCK_ALERT_QUEUE_NAME,
    {
      connection
    }
  );

export default stockAlertQueue;