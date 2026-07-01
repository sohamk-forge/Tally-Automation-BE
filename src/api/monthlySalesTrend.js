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

    console.log(`--- [MonthlySalesTrend] Requesting Tally chunk ${fromStr} to ${toStr} for "${company}" ---`);

    try {
      const tallyResponse = await axios.post(
        "http://localhost:9000",
        xml,
        {
          headers: { "Content-Type": "application/xml" },
          timeout: 60000
        }
      );

      const parsed = await xml2js.parseStringPromise(tallyResponse.data, {
        explicitArray: false,
        trim: true
      });

      const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
      const vouchers = collection?.VOUCHER;

      if (vouchers) {
        const list = Array.isArray(vouchers) ? vouchers : [vouchers];
        allVouchers.push(...list);
      }
    } catch (err) {
      console.error(
        `❌ [MonthlySalesTrend] Tally chunk fetch failed for ${fromStr}-${toStr}:`,
        err.message
      );
    }

    current = chunkEnd;
  }

  console.log(`=== [MonthlySalesTrend] TOTAL VOUCHERS FETCHED (raw, before dedup): ${allVouchers.length} ===`);

  // Chunk boundaries overlap by one day. Tally can return the boundary
  // day's vouchers in BOTH adjacent chunks, so they get double-counted
  // unless deduplicated. Dedup using GUID if present, else composite key.
  const seen = new Set();
  const dedupedVouchers = [];

  for (const v of allVouchers) {
    const guid = getVal(v?.GUID);
    const key =
      guid ||
      `${getVal(v?.DATE)}|${getVal(v?.VOUCHERNUMBER)}|${getVal(v?.AMOUNT)}|${getVal(v?.PARTYLEDGERNAME)}`;

    if (seen.has(key)) continue;
    seen.add(key);
    dedupedVouchers.push(v);
  }

  console.log(`=== [MonthlySalesTrend] TOTAL VOUCHERS AFTER DEDUP: ${dedupedVouchers.length} (removed ${allVouchers.length - dedupedVouchers.length} duplicates) ===`);

  return dedupedVouchers;
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
   VOUCHER TYPE CHECK
=================================================== */
function isRealSalesVoucher(voucherTypeNameRaw) {
  const type = (voucherTypeNameRaw || "").toString().toLowerCase();
  if (!type.includes("sales")) return false;
  if (type.includes("return")) return false;
  if (type.includes("credit note")) return false;
  if (type.includes("debit note")) return false;
  return true;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/* ===================================================
   BUILD MONTHLY SALES TREND
=================================================== */
function getMonthlySalesTrend(vouchers, yearStart, yearEnd) {
  const buckets = {};

  let current = new Date(yearStart);
  const end = new Date(yearEnd);
  while (current < end) {
    const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-01`;
    buckets[key] = {
      period_start: key,
      month_label: `${MONTH_NAMES[current.getMonth()]} ${current.getFullYear()}`,
      sales_total: 0
    };
    current.setMonth(current.getMonth() + 1);
  }

  const endDate = new Date(yearEnd);

  for (const v of vouchers) {
    const dateStr = parseTallyDate(v?.DATE);
    if (!dateStr) continue;

    const d = new Date(dateStr);
    if (d >= endDate) continue;

    const voucherType = getVal(v?.VOUCHERTYPENAME) || "";
    if (!isRealSalesVoucher(voucherType)) continue;

    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

    if (!buckets[key]) {
      buckets[key] = {
        period_start: key,
        month_label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
        sales_total: 0
      };
    }

    buckets[key].sales_total += getVoucherAmount(v);
  }

  return Object.values(buckets)
    .map((b) => ({
      ...b,
      sales_total: Math.round(b.sales_total * 100) / 100
    }))
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
}

/* ===================================================
   ROUTE
   GET /api/v1/monthly-sales-trend?company_id=1
=================================================== */
router.get("/monthly-sales-trend", async (req, res) => {
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

    // 🔍 TEMP DEBUG — dump every March voucher with date + amount
    // to help pin down the ₹0.36 mismatch. Remove this block once
    // the issue is found and fixed.
    const marchVouchers = vouchers.filter((v) => {
      const dateStr = parseTallyDate(v?.DATE);
      if (!dateStr) return false;
      const d = new Date(dateStr);
      return d.getFullYear() === 2026 && d.getMonth() === 2; // March = month index 2
    });

    console.log(`🔍 March voucher count: ${marchVouchers.length}`);
    marchVouchers
      .sort((a, b) => new Date(parseTallyDate(a.DATE)) - new Date(parseTallyDate(b.DATE)))
      .forEach((v) => {
        console.log(
          `${parseTallyDate(v.DATE)} | VchNo: ${getVal(v.VOUCHERNUMBER)} | Type: ${getVal(v.VOUCHERTYPENAME)} | Amount: ${getVoucherAmount(v)} | GUID: ${getVal(v.GUID)}`
        );
      });

    const marchTotal = marchVouchers.reduce((sum, v) => sum + getVoucherAmount(v), 0);
    console.log(`🔍 March computed total: ${marchTotal}`);
    // 🔍 END TEMP DEBUG

    const trend = getMonthlySalesTrend(vouchers, yearStart, yearEnd);

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      company,
      financial_year: fyLabel,
      voucher_count: vouchers.length,
      data: trend
    });

  } catch (err) {
    console.error("❌ MONTHLY SALES TREND ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;