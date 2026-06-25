import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const SALES_QUEUE_NAME = "sales-invoice-queue";

export const salesQueue = new Queue(SALES_QUEUE_NAME, {
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
});

export function getSalesJobId(salesId) {
  return `sales-${salesId}`;
}