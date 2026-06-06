import { Queue } from "bullmq";
import IORedis from "ioredis";

export const INVOICE_QUEUE_NAME =
  "invoice-push";

export const INVOICE_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

export function getInvoiceJobId(invoiceId) {
  return `invoice-${invoiceId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const invoiceQueue = new Queue(
  INVOICE_QUEUE_NAME,
  {
    connection
  }
);