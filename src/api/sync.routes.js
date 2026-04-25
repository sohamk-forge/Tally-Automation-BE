import express from "express";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import {
  getCompaniesXML,
  getLedgersXML,
  getProductsXML,
  getVouchersXML
} from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";

const router = express.Router();

/* Health Check */
router.get("/health", async (req, res) => {
  try {
    res.json({
      status: "success",
      message: "Sync routes working"
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message || "Unknown error"
    });
  }
});

/* Sync Companies : Tally -> PostgreSQL */
router.post("/companies", async (req, res) => {
  try {
    const xml = getCompaniesXML();

    const responseXML = await sendToTally(xml);
    const parsed = parseXML(responseXML);

    const companies =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY || [];

    const companyList = Array.isArray(companies)
      ? companies
      : [companies];

    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    for (const item of companyList) {
      const name =
        item?.NAME ||
        item?.$?.NAME ||
        item;

      if (!name) continue;

      fetched++;

      const result = await pool.query(
        `
        INSERT INTO companies(name)
        VALUES($1)
        ON CONFLICT(name)
        DO NOTHING
        RETURNING id
        `,
        [String(name).trim()]
      );

      if (result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    res.json({
      status: "success",
      message: "Companies synced successfully",
      fetched,
      inserted,
      skipped
    });

  } catch (err) {
    console.error("Sync Companies Error:", err);

    res.status(500).json({
      status: "error",
      message: err.message || "Sync failed"
    });
  }
});

/* Sync Ledgers */
router.get("/ledgers", async (req, res) => {
  try {
    const company = req.query.company;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company query required"
      });
    }

    const xml = getLedgersXML(company);

    const responseXML = await sendToTally(xml);
    const parsed = parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    let ledgers = [];

    function extractLedgers(obj) {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(extractLedgers);
        return;
      }

      if (typeof obj === "object") {
        if (obj.NAME) {
          ledgers.push({
            name: obj.NAME,
            parent: obj.PARENT || null
          });
        }

        for (const key in obj) {
          extractLedgers(obj[key]);
        }
      }
    }

    extractLedgers(collection);

    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    let fetchedData = [];
    let insertedData = [];

    for (const item of ledgers) {
      fetched++;

      fetchedData.push({
        ledger_name: item.name,
        parent_group: item.parent
      });

      const result = await pool.query(
        `
        INSERT INTO ledgers
        (company_name, ledger_name, parent_group)
        VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING
        RETURNING ledger_name
        `,
        [company, item.name, item.parent]
      );

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
      message: "Ledgers sync completed",
      company,
      fetched,
      inserted,
      skipped,
      fetched_data: fetchedData,
      inserted_data: insertedData
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message || "Unknown error"
    });
  }
});

/* Sync Products */
router.get("/products", async (req, res) => {
  try {
    const company = req.query.company;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company query required"
      });
    }

    const xml = getProductsXML(company);

    const responseXML = await sendToTally(xml);
    const parsed = parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    let products = [];

    function extractProducts(obj) {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(extractProducts);
        return;
      }

      if (typeof obj === "object") {
        if (obj.NAME) {
          products.push({
            name: obj.NAME
          });
        }

        for (const key in obj) {
          extractProducts(obj[key]);
        }
      }
    }

    extractProducts(collection);

    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    let fetchedData = [];
    let insertedData = [];

    for (const item of products) {
      fetched++;

      fetchedData.push({
        product_name: item.name
      });

      const result = await pool.query(
        `
        INSERT INTO products
        (company_name, product_name)
        VALUES($1,$2)
        ON CONFLICT DO NOTHING
        RETURNING product_name
        `,
        [company, item.name]
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
    res.status(500).json({
      status: "error",
      message: err.message || "Unknown error"
    });
  }
});

/* Sync Vouchers */
router.get("/vouchers", async (req, res) => {
  try {
    const company = req.query.company;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company query required"
      });
    }

    const xml = getVouchersXML(company);

    const responseXML = await sendToTally(xml);
    const parsed = parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    let vouchers = [];

    function extractVouchers(obj) {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(extractVouchers);
        return;
      }

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

        for (const key in obj) {
          extractVouchers(obj[key]);
        }
      }
    }

    extractVouchers(collection);

    let fetched = 0;
    let inserted = 0;
    let skipped = 0;

    for (const item of vouchers) {
      fetched++;

      const result = await pool.query(
        `
        INSERT INTO vouchers
        (company_name, voucher_type, voucher_number, voucher_date, party_name, amount)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING
        RETURNING voucher_number
        `,
        [
          company,
          item.type,
          item.number,
          item.date,
          item.party,
          item.amount
        ]
      );

      if (result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    res.json({
      status: "success",
      message: "Vouchers sync completed",
      company,
      fetched,
      inserted,
      skipped
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
message: err.message || "Unknown error"
    });
  }
});

export default router;