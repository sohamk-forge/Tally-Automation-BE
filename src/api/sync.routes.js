import express from "express";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import { runProductSync } from "../jobs/syncJob.js";
import {
  getCompaniesXML,
  getLedgersXML,
  getProductsXML,
  getVouchersXML
} from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

const router = express.Router();

/* ---------------- SAFE EXTRACT ---------------- */

function extractValues(obj, key) {
  const result = [];
  const visited = new Set();

  function walk(data) {
    if (!data || typeof data !== "object") return;

    if (visited.has(data)) return;
    visited.add(data);

    if (Array.isArray(data)) return data.forEach(walk);

    if (data[key]) {
      result.push({ name: String(data[key]).trim() });
    }

    Object.values(data).forEach(walk);
  }

  walk(obj);
  return result;
}

/* ---------------- DB HELPER ---------------- */

async function fetchFromDB(table) {
  const result = await pool.query(`SELECT * FROM ${table}`);
  return result.rows;
}

/* ---------------- HEALTH ---------------- */

router.get("/health", (req, res) => {
  res.json({ status: "success", message: "Sync working" });
});

/* ---------------- QUEUE ---------------- */

router.get("/products-queue", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

  await runProductSync(company);
  res.json({ message: "Job added" });
});

/* ---------------- COMPANIES ---------------- */

router.get("/companies", async (req, res) => {
  try {
    const xml = getCompaniesXML();

    console.log("📤 XML Sent:\n", xml);

    const responseXML = await sendToTally(xml);

    console.log("📥 Tally Response:\n", responseXML);
    
    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);

    const companies =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY || [];

    const list = Array.isArray(companies) ? companies : [companies];

    let inserted = 0;

    for (const item of list) {
      const name = item?.NAME || item;
      if (!name) continue;

      const result = await pool.query(
        `INSERT INTO app.companies(name, tally_company_name, created_at)
         VALUES($1, $1, NOW())
         ON CONFLICT(name) DO NOTHING`,
        [String(name).trim()]
      );

      if (result.rowCount > 0) inserted++;
    }

    return res.json({
      status: "success",
      source: "tally",
      inserted,
      total: list.length
    });

  } catch (err) {
    console.log("⚠️ Tally failed → DB fallback (companies)");

    const data = await fetchFromDB("app.companies");

    return res.json({
      status: "success",
      source: "database",
      count: data.length,
      data
    });
  }
});

/* ---------------- LEDGERS ---------------- */

router.get("/ledgers", async (req, res) => {
  const company = req.query.company;

  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

  try {
    const xml = getLedgersXML(company);
    const responseXML = await sendToTally(xml);

    console.log("📥 LEDGER RAW RESPONSE:\n", responseXML);

    if (!responseXML) {
      throw new Error("Empty Tally response");
    }

    if (!responseXML.includes("<ENVELOPE>")) {
      console.log("⚠️ Non-envelope response:", responseXML);
      throw new Error("Tally not returning ledger data");
    }

    const parsed = parseXML(responseXML);
    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ||
      parsed?.ENVELOPE?.BODY?.DATA;

    if (!collection) {
      throw new Error("No ledger data found");
    }

    const ledgers = [];

    function extract(obj) {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(extract);
        return;
      }

      if (typeof obj === "object") {
        if (obj.NAME) {
          const name = String(obj.NAME)
            .replace(/&#13;&#10;|\r|\n/g, "")
            .trim();

          const parent = obj.PARENT
            ? String(obj.PARENT)
                .replace(/&#13;&#10;|\r|\n/g, "")
                .trim()
            : null;

          ledgers.push({ name, parent });
        }

        Object.values(obj).forEach(extract);
      }
    }

    extract(collection);

    if (!ledgers.length) {
      return res.json({
        status: "success",
        source: "tally",
        count: 0,
        data: []
      });
    }

    const names = ledgers.map(l => l.name);
    const parents = ledgers.map(l => l.parent);

    const result = await pool.query(
      `
      INSERT INTO app.ledgers (name, parent_group, created_at)
      SELECT x.name, x.parent, NOW()
      FROM UNNEST($1::text[], $2::text[]) AS x(name, parent)
      ON CONFLICT (name) DO NOTHING
      RETURNING name
      `,
      [names, parents]
    );

    return res.json({
      status: "success",
      source: "tally",
      inserted: result.rowCount,
      total: ledgers.length,
      data: ledgers
    });

  } catch (err) {
    console.log("❌ TALLY ERROR:", err.message);
    console.log("⚠️ Ledger sync failed → fallback DB");

    try {
      const result = await pool.query(`
        SELECT id, name, parent_group, created_at
        FROM app.ledgers
        ORDER BY created_at DESC
      `);

      const cleanDB = result.rows.map(item => ({
        ...item,
        name: item.name?.replace(/&#13;&#10;|\r|\n/g, "").trim(),
        parent_group: item.parent_group
          ?.replace(/&#13;&#10;|\r|\n/g, "")
          .trim()
      }));

      return res.json({
        status: "success",
        source: "database",
        count: cleanDB.length,
        data: cleanDB
      });

    } catch (dbErr) {
      console.log("❌ DB ERROR:", dbErr.message);

      return res.status(500).json({
        status: "error",
        message: "Both Tally and DB failed"
      });
    }
  }
});

/* ---------------- PRODUCTS ---------------- */

router.get("/products", async (req, res) => {
  const company = req.query.company;

  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

  try {
    const xml = getProductsXML(company);
    const responseXML = await sendToTally(xml);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    if (!collection) {
      throw new Error("No data found in Tally response");
    }

    const list = extractValues(collection, "NAME");

    if (!list.length) {
      return res.json({
        status: "success",
        source: "tally",
        count: 0,
        data: []
      });
    }

    const cleanData = list.map(item => ({
      name: item.name
        .replace(/&#13;&#10;|\r|\n/g, "")
        .trim()
    }));

    const names = cleanData.map(i => i.name);

    const result = await pool.query(
      `
      INSERT INTO app.stock_items (name, created_at)
      SELECT UNNEST($1::text[]), NOW()
      ON CONFLICT (name) DO NOTHING
      RETURNING name
      `,
      [names]
    );

    return res.json({
      status: "success",
      source: "tally",
      inserted: result.rowCount,
      total: cleanData.length,
      data: cleanData
    });

  } catch (err) {
    console.log("⚠️ Tally failed → fallback to DB");

    try {
      const result = await pool.query(
        `SELECT id, name, created_at 
         FROM app.stock_items 
         ORDER BY created_at DESC`
      );

      const cleanDB = result.rows.map(item => ({
        ...item,
        name: item.name
          ?.replace(/&#13;&#10;|\r|\n/g, "")
          .trim()
      }));

      return res.json({
        status: "success",
        source: "database",
        count: cleanDB.length,
        data: cleanDB
      });

    } catch (dbErr) {
      return res.status(500).json({
        status: "error",
        message: "Both Tally and DB failed"
      });
    }
  }
});

/* ---------------- VOUCHERS (FIXED - NOW INSERTS INTO DB) ---------------- */

router.get("/vouchers", async (req, res) => {
  const company = req.query.company;

  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

  try {
    const xml = getVouchersXML(company);
    const responseXML = await sendToTally(xml);
        console.log("📤 VOUCHER XML:", xml);
    console.log("📥 VOUCHER RESPONSE:", responseXML);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    // 🔥 Extract vouchers properly with all fields
    const vouchers = [];
    
    function extract(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) return obj.forEach(extract);
      
      if (typeof obj === "object") {
        if (obj.VOUCHERNUMBER) {
          vouchers.push({
            number: String(obj.VOUCHERNUMBER).replace(/&#13;&#10;|\r|\n/g, "").trim(),
            type: obj.VOUCHERTYPENAME ? String(obj.VOUCHERTYPENAME).replace(/&#13;&#10;|\r|\n/g, "").trim() : null,
            date: obj.DATE || null,
          });
        }
        Object.values(obj).forEach(extract);
      }
    }
    
    extract(collection);

    if (!vouchers.length) {
      return res.json({
        status: "success",
        source: "tally",
        count: 0,
        message: "No vouchers found",
        data: []
      });
    }

    // 🔥 INSERT INTO DATABASE
    const result = await pool.query(
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

    return res.json({
      status: "success",
      source: "tally",
      inserted: result.rowCount,
      total: vouchers.length,
      data: vouchers
    });

  } catch (err) {
    console.log("⚠️ Voucher sync failed → fallback DB");
    
    try {
      const result = await pool.query(`
        SELECT * FROM app.vouchers ORDER BY created_at DESC
      `);
      
      return res.json({
        status: "success",
        source: "database",
        count: result.rows.length,
        data: result.rows
      });
    } catch (dbErr) {
      return res.status(500).json({
        status: "error",
        message: "Both Tally and DB failed"
      });
    }
  }
});

export default router;