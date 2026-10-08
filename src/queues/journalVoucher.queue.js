import { Queue } from "bullmq";
import IORedis from "ioredis";

export const JOURNAL_VOUCHER_QUEUE_NAME =
  "journal-voucher";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password:
    process.env.REDIS_PASSWORD || undefined,
  port: Number(
    process.env.REDIS_PORT || 6379
  ),
  maxRetriesPerRequest: null
});

export const journalVoucherQueue =
  new Queue(
    JOURNAL_VOUCHER_QUEUE_NAME,
    {
      connection
    }
  );