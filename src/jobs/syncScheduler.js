import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
});

export const syncQueue = new Queue("tally-sync", { connection });

export async function startScheduler() {
  const company = "Venkateshwara Traders";

  await syncQueue.add(
    "auto-product-sync",
    { company },
    {
      repeat: {
        every: 5 * 60 * 1000,
      },
    }
  );

  console.log("⏱ Auto sync running every 5 minutes");
}