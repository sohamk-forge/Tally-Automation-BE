import { Queue } from "bullmq";
import IORedis from "ioredis";

export const VOUCHER_QUEUE_NAME = "pushVoucher";

export const VOUCHER_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: 100,
  removeOnFail: 100
};

export function getVoucherJobId(voucherId) {
  return `voucher-${voucherId}`;
}

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const voucherQueue = new Queue(
  VOUCHER_QUEUE_NAME,
  { connection }
);

/*
====================================
SAFE ENQUEUE

BullMQ treats jobId as a unique key. If a job with the same
jobId already exists in Redis (in ANY state — including
"failed" or "completed"), calling queue.add() again with that
same jobId is a SILENT NO-OP: no new job is created, no error
is thrown, and the existing (stale) job is returned untouched.

This caused the bug where reassigning a ledger to a previously
FAILED voucher would flip its Postgres status to PENDING, but
never actually re-queue it in Redis — because a failed job with
the same jobId was still sitting there.

This helper is the single source of truth for enqueueing a
voucher job. It checks whether an existing job is already in a
"processable" state (still going to run) and leaves it alone;
otherwise it removes the stale job before adding a fresh one.

Use this everywhere a voucher needs to be queued — routes,
worker startup recovery, anywhere else — instead of calling
voucherQueue.add() directly.
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

export async function safeEnqueueVoucher(voucherId) {
  const jobId = getVoucherJobId(voucherId);
  const existingJob = await voucherQueue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (PROCESSABLE_STATES.includes(state)) {
      // Already queued / running — don't touch it, don't duplicate it.
      return { action: "already_queued", jobId, state };
    }

    // Stale job (failed / completed / unknown) — remove before re-adding,
    // otherwise BullMQ silently ignores the new add() call.
    await existingJob.remove();
  }

  await voucherQueue.add(
    "pushVoucher",
    { voucherId },
    { ...VOUCHER_JOB_OPTIONS, jobId }
  );

  return { action: "enqueued", jobId };
}