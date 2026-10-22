import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const POST_INVOICE_REFRESH_QUEUE_NAME = "post-invoice-refresh-queue";

export const postInvoiceRefreshQueue = new Queue(POST_INVOICE_REFRESH_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

export function getPostInvoiceRefreshJobId(kind, invoiceId) {
  return `post-invoice-${kind}-${invoiceId}`;
}

const PROCESSABLE_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children"
];

// kind: "sales" | "purchase". Same pattern as safeEnqueueSalesPrint: a stale
// finished job under the same jobId would make a plain add() a silent no-op,
// which would skip the refresh when an invoice is edited and re-posted.
export async function safeEnqueuePostInvoiceRefresh(kind, invoiceId) {
  const jobId = getPostInvoiceRefreshJobId(kind, invoiceId);
  const existingJob = await postInvoiceRefreshQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();
    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }
    await existingJob.remove();
  }

  // Enqueued right after the connector-result transaction commits; the short
  // delay is only a cushion, the worker re-checks the row and BullMQ retries.
  await postInvoiceRefreshQueue.add("post-invoice-refresh", { kind, invoiceId }, { jobId, delay: 1000 });

  return { action: "enqueued", jobId };
}
