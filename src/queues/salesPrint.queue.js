import { Queue } from "bullmq";
import { redisConnection } from "../config/redis.js";

export const SALES_PRINT_QUEUE_NAME = "sales-print-finalize-queue";

export const salesPrintQueue = new Queue(SALES_PRINT_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

export function getSalesPrintJobId(salesId) {
  return `sales-print-${salesId}`;
}

const PROCESSABLE_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children"
];

// Same pattern as safeEnqueueSales (sales.queue.js): a stale finished job under
// the same jobId would make a plain add() a silent no-op.
export async function safeEnqueueSalesPrint(salesId) {
  const jobId = getSalesPrintJobId(salesId);
  const existingJob = await salesPrintQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();
    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }
    await existingJob.remove();
  }

  // Enqueued by connector.routes.js right after the result transaction
  // commits; the short delay is only a cushion. The worker re-checks the row
  // and BullMQ retries if the commit still isn't visible.
  await salesPrintQueue.add("sales-print-finalize", { salesId }, { jobId, delay: 1000 });

  return { action: "enqueued", jobId };
}
