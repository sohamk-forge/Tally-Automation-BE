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
