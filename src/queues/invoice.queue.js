// =========================================
// src/queues/invoices.queue.js
// =========================================

import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const INVOICE_QUEUE_NAME = "invoice-queue";

export const invoiceQueue = new Queue(INVOICE_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

export function getInvoiceJobId(invoiceId) {
  return `invoice-${invoiceId}`;
}