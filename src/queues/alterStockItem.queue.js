import { Queue } from "bullmq";
import IORedis from "ioredis";

export const ALTER_STOCK_ITEM_QUEUE_NAME =
  "alter-stock-item-push";

export const ALTER_STOCK_ITEM_JOB_OPTIONS = {
  attempts: 5,

  backoff: {
    type: "exponential",
    delay: 5000
  },

  removeOnComplete: 100,

  removeOnFail: 100
};

export function getAlterStockItemJobId(
  stockItemId
) {
  return `alter-stock-item-${stockItemId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",

  port: Number(
    process.env.REDIS_PORT || 6379
  ),

  maxRetriesPerRequest: null
});

export const alterStockItemQueue =
  new Queue(
    ALTER_STOCK_ITEM_QUEUE_NAME,
    {
      connection
    }
  );

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueStockItem (stockItem.queue.js). Single source of truth
for enqueueing an "alter" stock item job — pushStockItemOpening.routes.js,
the auto-chain in connector.routes.js, and worker startup recovery should
all use this instead of calling alterStockItemQueue.add() directly.
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

export async function safeEnqueueAlterStockItem(stockItemId, userId) {
  const jobId = getAlterStockItemJobId(stockItemId);
  const existingJob = await alterStockItemQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await alterStockItemQueue.add(
    "push-alter-stock-item",
    { stockItemId, userId },
    { ...ALTER_STOCK_ITEM_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}

export default alterStockItemQueue;