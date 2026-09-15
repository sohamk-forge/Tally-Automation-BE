// queues/bulkPurchase.queue.js

import { Queue } from "bullmq";
import IORedis from "ioredis";

export const BULK_PURCHASE_QUEUE_NAME = "bulk-purchase";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const bulkPurchaseQueue = new Queue(
  BULK_PURCHASE_QUEUE_NAME,
  { connection }
);

export const BULK_PURCHASE_JOB_OPTIONS = {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 1000
};

// Two job names on the same queue/worker — a Purchase Report upload only
// ever touches its own PO lines, a Spare Statement upload only ever
// re-checks the existing pending_dispatch backlog. Same pipeline, two
// independent entry points (see plan.md's "Revised upload shape").
export function getPurchaseReportJobId(batchId) {
  return `bulk-purchase-report-${batchId}`;
}

export function getSpareStatementJobId(batchId) {
  return `bulk-purchase-statement-${batchId}`;
}
