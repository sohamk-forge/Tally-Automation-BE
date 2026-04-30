import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import { getProductsXML } from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

// ─── Redis Connection ─────────────────────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down worker...");
  await connection.quit();
  process.exit(0);
});

// ─── Product Extractor ────────────────────────────────────────────────────────
function extractProducts(collection) {
  const products = [];
  const seen = new Set();

  function traverse(obj) {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach(traverse);
      return;
    }

    if (obj.STOCKITEM) {
      traverse(obj.STOCKITEM);
      return;
    }

    if (obj.NAME && typeof obj.NAME === "string") {
      const name = obj.NAME.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        products.push({ name });
      }
      return;
    }

    for (const key in obj) {
      traverse(obj[key]);
    }
  }

  traverse(collection);
  return products;
}

// ─── Worker ───────────────────────────────────────────────────────────────────
new Worker(
  "tally-sync",
  async (job) => {
    const { company } = job.data;

    if (!company) {
      throw new Error("Company is required");
    }

    console.log(`\n[Job ${job.id}] Sync started for: ${company}`);

    const client = await pool.connect();

    try {
      await job.updateProgress(10);

      // 1. Fetch from Tally (with timeout safety)
      const xml = getProductsXML(company);

      const responseXML = await Promise.race([
        sendToTally(xml),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Tally timeout")), 30000)
        ),
      ]);

     if (!responseXML) {
  throw new Error("Empty response from Tally");
}

if (!responseXML.includes("<ENVELOPE>")) {
  console.log("⚠️ RAW RESPONSE:", responseXML);
}

      console.log(
        `[Job ${job.id}] RAW RESPONSE:`,
        responseXML.slice(0, 300)
      );

      await job.updateProgress(30);

      // 2. Parse XML
      const parsed = parseXML(responseXML);

      console.log(
        `[Job ${job.id}] PARSED SAMPLE:`,
        JSON.stringify(parsed, null, 2).slice(0, 500)
      );

      // 3. Get collection
      const collection =
        parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ??
        parsed?.ENVELOPE?.BODY?.DATA ??
        null;

      if (!collection) {
        console.warn(`[Job ${job.id}] No COLLECTION found`);
        return { inserted: 0, skipped: 0 };
      }

      // 4. Extract products
      const products = extractProducts(collection);

      console.log(`[Job ${job.id}] Extracted ${products.length} products`);

      if (products.length === 0) {
        return { inserted: 0, skipped: 0 };
      }

      await job.updateProgress(60);

      // 5. Insert into DB (batch)
      await client.query("BEGIN");

      const names = products.map((p) => p.name);

      const result = await client.query(
        `
        INSERT INTO products (name)
        SELECT UNNEST($1::text[])
        ON CONFLICT (name) DO NOTHING
        RETURNING name
        `,
        [names]
      );

      await client.query("COMMIT");

      const inserted = result.rowCount || 0;
      const skipped = products.length - inserted;

      console.log(
        `[Job ${job.id}] Completed → Inserted: ${inserted}, Skipped: ${skipped}`
      );

      await job.updateProgress(100);

      return { inserted, skipped, total: products.length };
    } catch (err) {
      await client.query("ROLLBACK");

      console.error(`[Job ${job.id}] ERROR:`, err.message);

      throw err; // allow retry
    } finally {
      client.release();
    }
  },
  {
    connection,

    concurrency: 5,

    limiter: {
      max: 10,
      duration: 60000,
    },

    // ⭐ retry config
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  }
);

console.log("✅ Tally Sync Worker Running...");