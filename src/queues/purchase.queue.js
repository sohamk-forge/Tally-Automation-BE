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

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueSales (sales.queue.js) / safeEnqueueBank — BullMQ treats
jobId as a unique key, so re-adding the same jobId while a stale job
(failed/completed) still exists under it is a silent no-op. Single source
of truth for enqueueing a purchase-invoice job — the route and worker
startup recovery should both use this instead of calling
purchaseQueue.add() directly.
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

export async function safeEnqueuePurchase(invoiceId, userId) {
  const jobId = getPurchaseJobId(invoiceId);
  const existingJob = await purchaseQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await purchaseQueue.add(
    "push-invoice",
    { invoiceId, userId },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      jobId
    }
  );

  return { action: "enqueued", jobId };
}