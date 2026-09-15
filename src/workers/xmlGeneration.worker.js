console.log("🚀 xmlGeneration.worker.js loaded");

import { Worker } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { XML_GENERATION_QUEUE_NAME } from "../queues/xmlGeneration.queue.js";
import { generateXml, generateSalesXml } from "../services/xmlGenerator.js";

// concurrency: 1 — deliberately serial. This is the actual fix for the
// python.exe access-violation crash (see xmlGeneration.queue.js for the
// full story): confirmed via direct testing that the exact same payload
// succeeds 5/5 run sequentially, but fails repeatedly under concurrent
// spawning. Every purchase/sales push now funnels its XML generation
// through this single lane — slower under a big bulk backlog than the old
// concurrency-5 inline spawn, but reliable, which the old setup was not.
const worker = new Worker(
  XML_GENERATION_QUEUE_NAME,
  async (job) => {
    const { type, invoiceData } = job.data;

    if (type === "purchase") {
      return generateXml(invoiceData);
    }
    if (type === "sales") {
      return generateSalesXml(invoiceData);
    }
    throw new Error(`Unknown xml-generation job type: ${type}`);
  },
  {
    connection: redisConnection,
    concurrency: 1
  }
);

worker.on("failed", (job, error) => {
  console.error(`[XML-GENERATION] ❌ Job failed: ${job?.id} (${job?.name})`, error.message);
});

worker.on("error", (error) => {
  console.error("[XML-GENERATION] ❌ Worker error:", error.message);
});

console.log("✅ XML Generation BullMQ worker started (concurrency 1)");

export default worker;
