import axios from "axios";
import xml2js from "xml2js";
import pool from "../db/index.js";
import { redisConnection as redis } from "../config/redis.js";

import { DB_SCHEMA } from "../config/db.js";
const CACHE_TTL = 60;

/**
 * Generic Hybrid Engine for ALL Tally balances
 */
export async function getHybridBalance({
  company,
  type,                // sales / purchase / stock
  cacheKey,
  xmlBuilder,
  balanceField = "CLOSINGBALANCE",
  transform = (v) => v
}) {
  try {

    /* ===================== 1. CACHE ===================== */
    const cached = await redis.get(cacheKey);

    if (cached) {
      return {
        source: "cache",
        value: Number(cached)
      };
    }

    /* ===================== 2. DB ===================== */
    const dbResult = await pool.query(
      `SELECT closing_balance, updated_at
       FROM ${DB_SCHEMA}.account_closing_balances
       WHERE company_name = $1 AND balance_type = $2
       LIMIT 1`,
      [company, type]
    );

    const dbData = dbResult.rows[0];

    const isStale =
      !dbData ||
      (Date.now() - new Date(dbData.updated_at).getTime()) > 60000;

    if (dbData && !isStale) {
      await redis.setex(cacheKey, CACHE_TTL, dbData.closing_balance);

      return {
        source: "db",
        value: Number(dbData.closing_balance)
      };
    }

    /* ===================== 3. TALLY ===================== */
    const xml = xmlBuilder(company);

    const response = await axios.post("http://localhost:9000", xml, {
      headers: { "Content-Type": "application/xml" }
    });

    const parsed = await xml2js.parseStringPromise(response.data, {
      explicitArray: false,
      trim: true
    });

    const groups =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP;

    const list = Array.isArray(groups) ? groups : [groups];

    let total = 0;

    for (const g of list) {
      let val = g?.[balanceField];

      if (!val) continue;

      val = typeof val === "object" ? val._ : val;
      val = String(val).trim();

      if (val.endsWith("-")) {
        val = "-" + val.slice(0, -1);
      }

      let num = parseFloat(val);
      if (isNaN(num)) num = 0;

      total += num;
    }

    total = transform(total);

    /* ===================== 4. UPSERT DB ===================== */
    await pool.query(
      `INSERT INTO ${DB_SCHEMA}.account_closing_balances
       (company_name, balance_type, closing_balance, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_name, balance_type)
       DO UPDATE SET
         closing_balance = EXCLUDED.closing_balance,
         updated_at = NOW()`,
      [company, type, total]
    );

    /* ===================== 5. CACHE ===================== */
    await redis.setex(cacheKey, CACHE_TTL, total);

    return {
      source: "tally",
      value: total
    };

  } catch (err) {
    throw err;
  }
}