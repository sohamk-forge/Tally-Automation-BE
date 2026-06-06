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