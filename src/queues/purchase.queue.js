import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const PURCHASE_QUEUE_NAME = "purchase-invoice-queue";

export const purchaseQueue = new Queue(
  PURCHASE_QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export function getPurchaseJobId(invoiceId) {
  return `purchase-${invoiceId}`;
}