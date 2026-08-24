import { Queue } from "bullmq";
import IORedis from "ioredis";

export const SYNC_QUEUE_NAME = "sync-queue";

export const SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const syncQueue = new Queue(
  SYNC_QUEUE_NAME,
  { connection }
);

export function getSyncJobId(jobLogId) {
  return `sync-${jobLogId}`;
}

/*
====================================
SAFE ENQUEUE

Mirrors safeEnqueueBank / safeEnqueueSales / safeEnqueuePurchase — BullMQ
treats jobId as a unique key, so re-adding the same jobId while a stale
job (failed/completed) still exists under it is a silent no-op. Single
source of truth for enqueueing a sync job — both /manual and /manual-auto
in sync.routes.js, plus worker startup recovery, should use this instead
of calling syncQueue.add() directly.
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

export async function safeEnqueueSync(jobLogId, jobData) {
  const jobId = getSyncJobId(jobLogId);
  const existingJob = await syncQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      return { action: "already_queued", jobId, state };
    }

    await existingJob.remove();
  }

  await syncQueue.add(
    "manual-sync",
    jobData,
    { ...SYNC_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}