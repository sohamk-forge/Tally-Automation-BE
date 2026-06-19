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