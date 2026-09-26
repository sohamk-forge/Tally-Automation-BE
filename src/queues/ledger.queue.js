import { Queue } from "bullmq";
import IORedis from "ioredis";

export const LEDGER_QUEUE_NAME = "ledger-push";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

export const ledgerQueue = new Queue(
  LEDGER_QUEUE_NAME,
  { connection }
);