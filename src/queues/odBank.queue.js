import { Queue } from "bullmq";
import IORedis from "ioredis";

export const OD_BANK_QUEUE_NAME = "od-bank-push";

export const OD_BANK_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

export function getOdBankJobId(odBankId) {
  return `od-bank-${odBankId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const odBankQueue = new Queue(
  OD_BANK_QUEUE_NAME,
  { connection }
);

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueBank (bank.queue.js) — BullMQ treats jobId as a unique
key, so re-adding the same jobId while a stale job (failed/completed)
still exists under it is a silent no-op. This is the single source of
truth for enqueueing an OD/OC bank job — routes and worker startup
recovery should both use this instead of calling odBankQueue.add() directly.
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

export async function safeEnqueueOdBank(odBankId, userId) {
  const jobId = getOdBankJobId(odBankId);
  const existingJob = await odBankQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await odBankQueue.add(
    "push-od-bank",
    { odBankId, userId },
    { ...OD_BANK_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}
