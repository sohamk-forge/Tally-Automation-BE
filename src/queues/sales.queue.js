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

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueVoucher (voucher.queue.js) / safeEnqueueBank (bank.queue.js)
— BullMQ treats jobId as a unique key, so re-adding the same jobId while a
stale job (failed/completed) still exists under it is a silent no-op. This
is the single source of truth for enqueueing a sales-invoice job — the
direct push route, bulkSales.worker.js, bulkSalesV2.worker.js, and worker
startup recovery should all use this instead of calling salesQueue.add()
directly.
====================================
*/

const PROCESSABLE_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children"
];

export async function safeEnqueueSales(salesId, userId) {
  const jobId = getSalesJobId(salesId);
  const existingJob = await salesQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await salesQueue.add(
    "sales-invoice",
    { salesId, userId },
    { jobId }
  );

  return { action: "enqueued", jobId };
}