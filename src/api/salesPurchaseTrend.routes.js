import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pool from "../db/index.js";
import { getLedgerVouchersXML } from "../services/xmlBuilder.js";

const router = express.Router();

/* ===================================================
   GET COMPANY NAME + FINANCIAL YEAR FROM DB
=================================================== */
async function getCompanyInfo(companyId) {
  const result = await pool.query(
    `SELECT name, financial_year_start, financial_year_end
     FROM app_test.companies
     WHERE id = $1`,
    [companyId]
  );

  const row = result.rows[0];
  if (!row) return null;

  if (!row.financial_year_start || !row.financial_year_end) {
    const now = new Date();
    const y = now.getFullYear();
    return {
      name: row.name,
      yearStart: `${y}-01-01`,
      yearEnd: `${y + 1}-01-01`,
      fyLabel: `${y}-${y + 1}`
    };
  }

  const startYear = row.financial_year_start;
  const endYear = row.financial_year_end;

  return {
    name: row.name,
    yearStart: `${startYear}-04-01`,
    yearEnd: `${endYear}-04-01`,
    fyLabel: `${startYear}-${endYear}`
  };
}

/* ===================================================
   FETCH LIVE VOUCHERS FROM TALLY — CHUNKED BY MONTH
=================================================== */
async function fetchVouchersFromTally(company, fromDate, toDate) {
  const allVouchers = [];

  let current = new Date(
    `${fromDate.slice(0, 4)}-${fromDate.slice(4, 6)}-${fromDate.slice(6, 8)}`
  );
  const end = new Date(
    `${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}`
  );

  while (current < end) {
    const chunkStart = new Date(current);
    const chunkEnd = new Date(current);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const fmt = (d) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

    const fromStr = fmt(chunkStart);
    const toStr = fmt(chunkEnd);

    const xml = getLedgerVouchersXML(company, fromStr, toStr);

    console.log(`--- Requesting Tally chunk ${fromStr} to ${toStr} for "${company}" ---`);

    try {
      const tallyResponse = await axios.post(
        "http://localhost:9000",
        xml,
        {
          headers: { "Content-Type": "application/xml" },
          timeout: 60000
        }
      );

      console.log(`Tally raw response length: ${tallyResponse.data?.length || 0}`);

      const parsed = await xml2js.parseStringPromise(tallyResponse.data, {
        explicitArray: false,
        trim: true
      });

      console.log("Parsed ENVELOPE.BODY.DATA keys:", Object.keys(parsed?.ENVELOPE?.BODY?.DATA || {}));

      const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
      const vouchers = collection?.VOUCHER;

      if (vouchers) {
        const list = Array.isArray(vouchers) ? vouchers : [vouchers];
        console.log(`✅ Found ${list.length} vouchers in this chunk`);
        allVouchers.push(...list);
      } else {
        console.log("⚠️ No VOUCHER key found in this chunk's COLLECTION. Collection content:", JSON.stringify(collection, null, 2).slice(0, 1000));
      }
    } catch (err) {
      console.error(
        `❌ Tally chunk fetch failed for ${fromStr}-${toStr}:`,
        err.message
      );
    }

    current = chunkEnd;
  }

  console.log(`=== TOTAL VOUCHERS FETCHED: ${allVouchers.length} ===`);
  if (allVouchers.length > 0) {
    console.log("First voucher sample:", JSON.stringify(allVouchers[0], null, 2));
  }

  return allVouchers;
}

const getVal = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") {
    return v._ ?? v["#text"] ?? null;
  }
  return v;
};

const parseAmount = (val) => {
  const str = getVal(val);
  if (str === null) return 0;
  const n = parseFloat(String(str).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
};

/* ===================================================
   PARSE TALLY DATE (YYYYMMDD) -> "YYYY-MM-DD"
=================================================== */
function parseTallyDate(raw) {
  const str = getVal(raw);
  if (!str) return null;
  const clean = String(str).trim();
  if (clean.length < 8) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

/* ===================================================
   COMPUTE VOUCHER AMOUNT
=================================================== */
function getVoucherAmount(v) {
  if (v?.AMOUNT !== undefined && v?.AMOUNT !== null) {
    const topAmount = Math.abs(parseAmount(v.AMOUNT));
    if (topAmount > 0) return topAmount;
  }

  let entries = v?.ALLLEDGERENTRIES?.LIST;
  if (!entries) entries = v?.["ALLLEDGERENTRIES.LIST"];

  const entryList = Array.isArray(entries) ? entries : entries ? [entries] : [];

  let amount = 0;
  for (const e of entryList) {
    amount += Math.abs(parseAmount(e?.AMOUNT));
  }

  return amount / 2;
}

/* ===================================================
   BUCKET KEY HELPERS
=================================================== */
function getBucketKey(dateStr, period) {
  const d = new Date(dateStr);

  if (period === "day") return dateStr;

  if (period === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }

  if (period === "year") {
    return `${d.getFullYear()}-01-01`;
  }

  if (period === "week") {
    const day = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - day + 1);
    return monday.toISOString().split("T")[0];
  }

  return dateStr;
}

/* ===================================================
   GROUP VOUCHERS INTO BUCKETS -> sales/purchase/net
=================================================== */
function bucketVouchers(vouchers, period) {
  const buckets = {};

  for (const v of vouchers) {
    const dateStr = parseTallyDate(v?.DATE);
    if (!dateStr) continue;

    const voucherType = (getVal(v?.VOUCHERTYPENAME) || "").toString().toLowerCase();
    const isSales = voucherType.includes("sales");
    const isPurchase = voucherType.includes("purchase");
    if (!isSales && !isPurchase) continue;

    const amount = getVoucherAmount(v);
    const key = getBucketKey(dateStr, period);

    if (!buckets[key]) {
      buckets[key] = { period_start: key, sales_total: 0, purchase_total: 0 };
    }

    if (isSales) buckets[key].sales_total += amount;
    if (isPurchase) buckets[key].purchase_total += amount;
  }

  return Object.values(buckets)
    .map((b) => ({ ...b, net: b.sales_total - b.purchase_total }))
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
}

/* ===================================================
   MAIN ROUTE
   GET /api/v1/trends/sales-purchase?company_id=1
=================================================== */
router.get("/sales-purchase", async (req, res) => {
  try {
    const companyId = req.query.company_id;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "company_id query parameter is required"
      });
    }

    const companyInfo = await getCompanyInfo(companyId);

    if (!companyInfo) {
      return res.status(404).json({
        status: "error",
        message: `Company with id ${companyId} not found. Run /api/v1/companies/sync first.`
      });
    }

    const { name: company, yearStart, yearEnd, fyLabel } = companyInfo;

    const tallyFrom = yearStart.replace(/-/g, "");
    const tallyTo = yearEnd.replace(/-/g, "");

    const vouchers = await fetchVouchersFromTally(company, tallyFrom, tallyTo);

    // day/week/month: keep sales_total + purchase_total only (no net)
    const stripNet = (arr) =>
      arr.map(({ period_start, sales_total, purchase_total }) => ({
        period_start,
        sales_total,
        purchase_total
      }));

    const day = stripNet(bucketVouchers(vouchers, "day"));
    const week = stripNet(bucketVouchers(vouchers, "week"));
    const month = stripNet(bucketVouchers(vouchers, "month"));

    // year: keep sales_total + purchase_total + net (full data)
    const year = bucketVouchers(vouchers, "year");

    const todayStr = new Date().toISOString().split("T")[0];
    const rawToday = bucketVouchers(vouchers, "day").find(
      (d) => d.period_start === todayStr
    );
    const today = rawToday
      ? {
          period_start: rawToday.period_start,
          sales_total: rawToday.sales_total,
          purchase_total: rawToday.purchase_total
        }
      : {
          period_start: todayStr,
          sales_total: 0,
          purchase_total: 0
        };

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      company,
      financial_year: fyLabel,
      financial_year_start: yearStart,
      financial_year_end: yearEnd,
      voucher_count: vouchers.length,
      data: {
        today,
        day,
        week,
        month,
        year
      }
    });

  } catch (err) {
    console.error("❌ SALES-PURCHASE TREND ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;