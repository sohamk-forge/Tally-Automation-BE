import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import {
  getProductsXML,
  getLedgersXML,
  getCompaniesXML,
  getVouchersXML,
} from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

// ─── Redis Connection ─────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  maxRetriesPerRequest: null,
});

// ─── SAFE PRODUCT EXTRACTOR ───────────────────
function extractProducts(collection) {
  const items = [];
  const visited = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }

    if (obj.NAME) {
      items.push({
        name: String(obj.NAME).trim(),
        unit: obj.BASEUNITS || null,
        closing_balance: obj.CLOSINGBALANCE || null,
        alter_id: obj.ALTERID || null,
      });
    }

    Object.values(obj).forEach(walk);
  }

  walk(collection);
  return items;
}

// ─── GENERIC NAME EXTRACTOR (for ledgers/companies) ─────────
function extractNames(collection) {
  const items = new Set();
  const visited = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }

    if (obj.NAME && typeof obj.NAME === "string") {
      items.add(obj.NAME.trim());
    }

    Object.values(obj).forEach(walk);
  }

  walk(collection);
  return Array.from(items);
}

// ─── VOUCHER EXTRACTOR (FIXED) ───────────────────
function extractVouchers(collection) {
  const items = [];
  const visited = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }

    if (obj.VOUCHERNUMBER) {
      items.push({
        number: String(obj.VOUCHERNUMBER).replace(/&#13;&#10;|\r|\n/g, "").trim(),
        type: obj.VOUCHERTYPENAME ? String(obj.VOUCHERTYPENAME).replace(/&#13;&#10;|\r|\n/g, "").trim() : null,
        date: obj.DATE || null,
      });
    }

    Object.values(obj).forEach(walk);
  }

  walk(collection);
  return items;
}

// ─── WORKER ──────────────────────────────────
new Worker(
  "tally-sync",
  async (job) => {
    const { company, type } = job.data;
    console.log("JOB DATA:", job.data);

    const validTypes = ["products", "ledgers", "companies", "vouchers"];

    if (!type || !validTypes.includes(type)) {
      console.log("⚠️ Invalid job:", job.data);
      return;
    }

    console.log(`\n[JOB ${job.id}] ${type} sync → ${company}`);

    const client = await pool.connect();

    try {
      await job.updateProgress(10);

      // ─── XML BUILD ─────────────────────
      let xml;
      if (type === "products") xml = getProductsXML(company);
      else if (type === "ledgers") xml = getLedgersXML(company);
      else if (type === "companies") xml = getCompaniesXML();
      else if (type === "vouchers") xml = getVouchersXML(company);

      console.log("📤 XML SENT");

      // ─── FETCH FROM TALLY ──────────────
      const responseXML = await Promise.race([
        sendToTally(xml),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Tally timeout")), 120000)
        ),
      ]);

      console.log("📥 Tally Response (first 500 chars):", responseXML?.substring(0, 500));

      if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
        console.log("⚠️ Invalid Tally response");
        return { inserted: 0 };
      }

      await job.updateProgress(40);

      // ─── PARSE XML ─────────────────────
      const parsed = parseXML(responseXML);

      const collection =
        parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ||
        parsed?.ENVELOPE?.BODY?.DATA;

      if (!collection) {
        console.log("⚠️ No collection found");
        return { inserted: 0 };
      }

      await job.updateProgress(60);

      // ─── INSERT LOGIC ──────────────────
      await client.query("BEGIN");

      let result;

      // ================================
      // ✅ PRODUCTS
      // ================================
      if (type === "products") {
        const products = extractProducts(collection);

        if (!products.length) {
          console.log("⚠️ No products found");
          await client.query("ROLLBACK");
          return { inserted: 0 };
        }

        const names = products.map((p) => p.name);

        result = await client.query(
          `
          INSERT INTO app.stock_items (name, created_at)
          SELECT UNNEST($1::text[]), NOW()
          ON CONFLICT (name) DO NOTHING
          RETURNING name
          `,
          [names]
        );

        console.log(`📦 Products extracted: ${products.length}`);
      }

      // ================================
      // ✅ COMPANIES
      // ================================
      else if (type === "companies") {
        const names = extractNames(collection);

        if (!names.length) {
          console.log("⚠️ No companies found");
          await client.query("ROLLBACK");
          return { inserted: 0 };
        }

        result = await client.query(
          `
          INSERT INTO app.companies (name, tally_company_name, created_at)
          SELECT 
            UNNEST($1::text[]), 
            UNNEST($1::text[]),
            NOW()
          ON CONFLICT (name) DO NOTHING
          RETURNING name
          `,
          [names]
        );

        console.log(`🏢 Companies extracted: ${names.length}`);
      }

      // ================================
      // ✅ LEDGERS
      // ================================
      else if (type === "ledgers") {
        const names = extractNames(collection);

        if (!names.length) {
          console.log("⚠️ No ledgers found");
          await client.query("ROLLBACK");
          return { inserted: 0 };
        }

        result = await client.query(
          `
          INSERT INTO app.ledgers (name, parent_group, created_at)
          SELECT UNNEST($1::text[]), NULL, NOW()
          ON CONFLICT (name) DO NOTHING
          RETURNING name
          `,
          [names]
        );

        console.log(`📒 Ledgers extracted: ${names.length}`);
      }

      // ================================
      // ✅ VOUCHERS (FIXED)
      // ================================
      else if (type === "vouchers") {
        const vouchers = extractVouchers(collection);

        if (!vouchers.length) {
          console.log("⚠️ No vouchers found");
          await client.query("ROLLBACK");
          return { inserted: 0 };
        }

        result = await client.query(
          `
          INSERT INTO app.vouchers (voucher_number, voucher_type, voucher_date, created_at)
          SELECT 
            x.number,
            x.type,
            CASE 
              WHEN x.date ~ '^[0-9]{8}$' THEN TO_DATE(x.date, 'YYYYMMDD')
              ELSE NULL
            END,
            NOW()
          FROM UNNEST($1::json[]) 
          AS x(number text, type text, date text)
          ON CONFLICT (voucher_number) DO NOTHING
          RETURNING voucher_number
          `,
          [vouchers]
        );

        console.log(`📄 Vouchers extracted: ${vouchers.length}`);
      }

      await client.query("COMMIT");

      console.log(`✅ Inserted: ${result.rowCount}`);

      await job.updateProgress(100);

      return {
        inserted: result.rowCount,
      };

    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Worker error:", err.message);
      return;
    } finally {
      client.release();
    }
  },
  {
    connection,
    concurrency: 1,
    limiter: {
      max: 5,
      duration: 60000,
    },
  }
);

console.log("🚀 Tally Sync Worker Running...");