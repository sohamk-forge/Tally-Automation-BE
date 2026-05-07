import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
});

export const syncQueue = new Queue("tally-sync", { connection });

export async function startScheduler() {
  const company = process.env.TALLY_COMPANY || "Venkateshwara Traders";

  // 🔹 PRODUCTS (once a day)
  await syncQueue.add(
    "auto-products-sync",
    { company, type: "products" },
    {
      repeat: { every: 24 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  // 🔹 LEDGERS (once a day)
  await syncQueue.add(
    "auto-ledgers-sync",
    { company, type: "ledgers" },
    {
      repeat: { every: 24 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  // 🔹 COMPANIES (once a day)
  await syncQueue.add(
    "auto-companies-sync",
    { company, type: "companies" },
    {
      repeat: { every: 24 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  // 🔹 VOUCHERS (once a day)
  await syncQueue.add(
    "auto-vouchers-sync",
    { company, type: "vouchers" },
    {
      repeat: { every: 24 * 60 * 60 * 1000 },
      removeOnComplete: true,
    }
  );

  console.log("⏱ Auto sync (products, ledgers, companies, vouchers) every 24 hours");
}