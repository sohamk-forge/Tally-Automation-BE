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

/* ---------------- COMPANIES SYNC ---------------- */

router.get("/companies", async (req, res) => {
  try {
    const xml = getCompaniesXML();
    const responseXML = await sendToTally(xml);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);
    const companies = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY || [];
    const list = Array.isArray(companies) ? companies : [companies];

    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    for (const item of list) {
      const name = item?.NAME ? String(item.NAME).trim() : null;
      if (!name) continue;

      const financial_year_start = item?.STARTINGFROM || null;
      const financial_year_end = item?.BOOKSFROM || null;

      const result = await pool.query(
        `
        INSERT INTO app.companies(name, financial_year_start, financial_year_end, created_at, updated_at)
        VALUES($1, $2, $3, NOW(), NOW())
        ON CONFLICT(name) DO UPDATE SET
          financial_year_start = EXCLUDED.financial_year_start,
          financial_year_end = EXCLUDED.financial_year_end,
          updated_at = NOW()
        `,
        [name, financial_year_start, financial_year_end]
      );
      if (result.rowCount > 0) inserted++;
    }

    res.json({
      status: "success",
      message: "Companies synced successfully",
      fetched,
      inserted,
      skipped
    });

  } catch (err) {
    console.log("❌ COMPANY SYNC ERROR:", err.message);
    const data = await pool.query(`
      SELECT id, name, financial_year_start, financial_year_end,
      CONCAT(LEFT(financial_year_start::TEXT, 4), '-', LEFT(financial_year_end::TEXT, 4)) as financial_year
      FROM app.companies ORDER BY id DESC
    `);
    return res.json({
      status: "success",
      source: "database",
      count: data.rows.length,
      data: data.rows
    });
  }
});

/* ---------------- LEDGERS SYNC ---------------- */

router.get("/ledgers", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

    const xml = getLedgersXML(company);

    const responseXML = await sendToTally(xml);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ||
                      parsed?.ENVELOPE?.BODY?.DATA;

    let ledgers = [];

    function extractLedgers(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) return obj.forEach(extract);
      if (typeof obj === "object") {
        if (obj.NAME) {
          const name = String(obj.NAME).replace(/&#13;&#10;|\r|\n/g, "").trim();
          const parent_group = obj.PARENT ? String(obj.PARENT).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;

          let address = null;
          if (obj.ADDRESS) {
            if (typeof obj.ADDRESS === 'string') {
              address = obj.ADDRESS.replace(/&#13;&#10;|\r|\n/g, "").trim();
            } else if (obj.ADDRESS?.LINE) {
              address = Array.isArray(obj.ADDRESS.LINE) 
                ? obj.ADDRESS.LINE.join(", ").replace(/&#13;&#10;|\r|\n/g, "").trim()
                : String(obj.ADDRESS.LINE).replace(/&#13;&#10;|\r|\n/g, "").trim();
            }
          }

          const state = obj.STATENAME ? String(obj.STATENAME).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;
          const gst_number = obj.PARTYGSTIN ? String(obj.PARTYGSTIN).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;
          const gst_type = obj.GSTREGISTRATIONTYPE ? String(obj.GSTREGISTRATIONTYPE).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;
          const pan_number = obj.INCOMETAXNUMBER ? String(obj.INCOMETAXNUMBER).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;
          const phone = obj.PHONE ? String(obj.PHONE).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;
          const email = obj.EMAIL ? String(obj.EMAIL).replace(/&#13;&#10;|\r|\n/g, "").trim() : null;

          let opening_balance = 0;
          let opening_balance_type = "Dr";
          if (obj.OPENINGBALANCE) {
            const balance = parseFloat(obj.OPENINGBALANCE);
            if (!isNaN(balance)) {
              opening_balance = Math.abs(balance);
              opening_balance_type = balance < 0 ? "Cr" : "Dr";
            }
          }

          ledgers.push({
            company_name: company,
            name,
            parent_group,
            address,
            state,
            gst_number,
            gst_type,
            pan_number,
            phone,
            email,
            opening_balance,
            opening_balance_type
          });
        }
        Object.values(obj).forEach(extract);
      }
    }

    extract(collection);

    if (!ledgers.length) {
      return res.json({ status: "success", source: "tally", count: 0, data: [] });
    }

    for (const ledger of ledgers) {
      await pool.query(
        `
        INSERT INTO app.ledgers (
          company_name, name, parent_group, address, state,
          gst_number, gst_type, pan_number, phone, email,
          opening_balance, opening_balance_type, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (name) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          parent_group = EXCLUDED.parent_group,
          address = EXCLUDED.address,
          state = EXCLUDED.state,
          gst_number = EXCLUDED.gst_number,
          gst_type = EXCLUDED.gst_type,
          pan_number = EXCLUDED.pan_number,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          opening_balance = EXCLUDED.opening_balance,
          opening_balance_type = EXCLUDED.opening_balance_type
        `,
        [
          ledger.company_name,
          ledger.name,
          ledger.parent_group,
          ledger.address,
          ledger.state,
          ledger.gst_number,
          ledger.gst_type,
          ledger.pan_number,
          ledger.phone,
          ledger.email,
          ledger.opening_balance,
          ledger.opening_balance_type
        ]
      );
    }

      if (result.rowCount > 0) {
        inserted++;

        insertedData.push({
          ledger_name: item.name,
          parent_group: item.parent
        });
      } else {
        skipped++;
      }
    }

    res.json({
      status: "success",
      source: "tally",
      total: ledgers.length,
      data: ledgers
    });

  } catch (err) {
    console.log("❌ LEDGER SYNC ERROR:", err.message);
    try {
      const result = await pool.query(`SELECT * FROM app.ledgers ORDER BY created_at DESC`);
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

/* ---------------- PRODUCTS SYNC ---------------- */

router.get("/products", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

    const xml = getProductsXML(company);

    const responseXML = await sendToTally(xml);
    const parsed = parseXML(responseXML);
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    if (!collection) throw new Error("No data found");

    const list = extractValues(collection, "NAME");
    if (!list.length) {
      return res.json({ status: "success", source: "tally", count: 0, data: [] });
    }

    const cleanData = list.map(item => ({
      name: item.name.replace(/&#13;&#10;|\r|\n/g, "").trim()
    }));
    const names = cleanData.map(i => i.name);

    const result = await pool.query(
      `INSERT INTO app.stock_items (name, created_at)
       SELECT UNNEST($1::text[]), NOW()
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [names]
    );

      if (result.rowCount > 0) {
        inserted++;

        insertedData.push({
          product_name: item.name
        });
      } else {
        skipped++;
      }
    }

    res.json({
      status: "success",
      message: "Products sync completed",
      company,
      fetched,
      inserted,
      skipped,
      fetched_data: fetchedData,
      inserted_data: insertedData
    });

  } catch (err) {
    console.log("⚠️ Products sync failed:", err.message);
    const result = await pool.query(`SELECT id, name, created_at FROM app.stock_items ORDER BY created_at DESC`);
    return res.json({ status: "success", source: "database", count: result.rows.length, data: result.rows });
  }
});

/* ---------------- VOUCHERS SYNC ---------------- */

router.get("/vouchers", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ message: "company required" });
  }

    const xml = getVouchersXML(company);

    const responseXML = await sendToTally(xml);

    if (!responseXML || !responseXML.includes("<ENVELOPE>")) {
      throw new Error("Invalid Tally response");
    }

    const parsed = parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    const vouchers = [];
    
    function extract(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) return obj.forEach(extract);
      if (typeof obj === "object") {
        if (obj.VOUCHERNUMBER || obj.DATE || obj.AMOUNT) {
          vouchers.push({
            type: obj.VOUCHERTYPENAME || null,
            number: obj.VOUCHERNUMBER || null,
            date: obj.DATE || null,
            party: obj.PARTYLEDGERNAME || null,
            amount: obj.AMOUNT || 0
          });
        }
        Object.values(obj).forEach(extract);
      }
    }
    
    extract(collection);

    if (!vouchers.length) {
      return res.json({ status: "success", source: "tally", count: 0, message: "No vouchers found", data: [] });
    }

    const result = await pool.query(
      `INSERT INTO app.vouchers (voucher_number, voucher_type, voucher_date, created_at)
       SELECT x.number, x.type,
         CASE WHEN x.date ~ '^[0-9]{8}$' THEN TO_DATE(x.date, 'YYYYMMDD') ELSE NULL END,
         NOW()
       FROM UNNEST($1::json[]) AS x(number text, type text, date text)
       ON CONFLICT (voucher_number) DO NOTHING
       RETURNING voucher_number`,
      [vouchers]
    );

    return res.json({
      status: "success",
      message: "Vouchers sync completed",
      company,
      fetched,
      inserted,
      skipped
    });

  } catch (err) {
    console.log("⚠️ Voucher sync failed:", err.message);
    const result = await pool.query(`SELECT * FROM app.vouchers ORDER BY created_at DESC`);
    return res.json({ status: "success", source: "database", count: result.rows.length, data: result.rows });
  }
});

export default router;