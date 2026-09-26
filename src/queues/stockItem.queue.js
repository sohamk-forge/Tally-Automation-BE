import { Queue } from "bullmq";
import IORedis from "ioredis";

export const STOCK_ITEM_QUEUE_NAME = "stock-item-push";

export const STOCK_ITEM_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

export function getStockItemJobId(stockItemId) {
  return `stock-item-${stockItemId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const stockItemQueue = new Queue(
  STOCK_ITEM_QUEUE_NAME,
  { connection }
);

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueBank / safeEnqueueSales — BullMQ treats jobId as a
unique key, so re-adding the same jobId while a stale job (failed/completed)
still exists under it is a silent no-op. This is the single source of truth
for enqueueing a "create" stock item job — routes, bulkStockItem.worker.js,
and worker startup recovery should all use this instead of calling
stockItemQueue.add() directly.
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

export async function safeEnqueueStockItem(stockItemId, userId) {
  const jobId = getStockItemJobId(stockItemId);
  const existingJob = await stockItemQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await stockItemQueue.add(
    "push-stock-item",
    { stockItemId, userId },
    { ...STOCK_ITEM_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}
