import { Queue } from "bullmq";
import IORedis from "ioredis";

export const BANK_QUEUE_NAME = "bank-push";

export const BANK_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

export function getBankJobId(bankId) {
  return `bank-${bankId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const bankQueue = new Queue(
  BANK_QUEUE_NAME,
  { connection }
);

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueVoucher (voucher.queue.js) — BullMQ treats jobId as a
unique key, so re-adding the same jobId while a stale job (failed/completed)
still exists under it is a silent no-op. This is the single source of truth
for enqueueing a bank job — routes and worker startup recovery should both
use this instead of calling bankQueue.add() directly.
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

export async function safeEnqueueBank(bankId, userId) {
  const jobId = getBankJobId(bankId);
  const existingJob = await bankQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await bankQueue.add(
    "push-bank",
    { bankId, userId },
    { ...BANK_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}
