import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pool from "../db/index.js";
import { getLedgerVouchersXML } from "../services/xmlBuilder.js";

const router = express.Router();

// ✅ Hardcoded limit — change this number if you want more/less ledgers
const TOP_LEDGERS_LIMIT = 3;

// ✅ Ledgers to exclude from "top sales" — these are tax/rounding
// entries that also sit on the credit side of a sales voucher,
// not actual product/income sales.
const EXCLUDED_LEDGER_KEYWORDS = [
  "cgst",
  "sgst",
  "igst",
  "gst",
  "round off",
  "round of",
  "roundoff",
  "discount",
  "tcs",
  "tds"
];

function isExcludedLedger(name) {
  const lower = name.toLowerCase();
  return EXCLUDED_LEDGER_KEYWORDS.some((kw) => lower.includes(kw));
}

/* ===================================================
   GET COMPANY NAME + FINANCIAL YEAR FROM DB
=================================================== */
async function getCompanyInfo(companyId, companyName) {
  let result;

  if (companyName) {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM app_test.companies
       WHERE LOWER(name) = LOWER($1)`,
      [companyName]
    );
  } else {
    result = await pool.query(
      `SELECT id, name, financial_year_start, financial_year_end
       FROM app_test.companies
       WHERE id = $1`,
      [companyId]
    );
  }

  const row = result.rows[0];
  if (!row) return null;

  // fallback if DB year missing
  if (!row.financial_year_start) {
    const now = new Date();
    const y = now.getFullYear();

    return {
      name: row.name,
      yearStart: `${y}-04-01`,
      yearEnd: `${y + 1}-04-01`,
      fyLabel: `${y}-${y + 1}`
    };
  }

  const startYear = Number(row.financial_year_start);

  // IMPORTANT:
  // Ignore DB financial_year_end because DB may contain wrong values like 2028.
  // Always force FY to 1 year only.
  const endYear = startYear + 1;

  console.log("COMPANY:", row.name);
  console.log("DB FY START:", row.financial_year_start);
  console.log("DB FY END:", row.financial_year_end);
  console.log("USING FY:", `${startYear}-04-01 to ${endYear}-04-01`);

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

    console.log(`--- [TopSalesLedgers] Requesting Tally chunk ${fromStr} to ${toStr} for "${company}" ---`);

    try {
      const tallyResponse = await axios.post(
        "http://localhost:9000",
        xml,
        {
          headers: { "Content-Type": "application/xml" },
          timeout: 600000
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
        `❌ [TopSalesLedgers] Tally chunk fetch failed for ${fromStr}-${toStr}:`,
        err.message
      );
    }

    current = chunkEnd;
  }

  console.log(`=== [TopSalesLedgers] TOTAL VOUCHERS FETCHED: ${allVouchers.length} ===`);

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
   HELPER: extract ledger entries array from a voucher
=================================================== */
function getLedgerEntries(v) {
  let entries = v?.ALLLEDGERENTRIES?.LIST;
  if (!entries) entries = v?.["ALLLEDGERENTRIES.LIST"];
  return Array.isArray(entries) ? entries : entries ? [entries] : [];
}

/* ===================================================
   TOP SELLING LEDGERS
   For each Sales voucher, the ledger entries where
   ISDEEMEDPOSITIVE = "No" are the credit side —
   i.e. the sales/income ledgers (not the customer
   account, which is debited / ISDEEMEDPOSITIVE = "Yes").
   Tax ledgers (CGST/SGST/IGST) and rounding ledgers
   are also on the credit side, so we exclude those
   explicitly to keep only genuine product/income sales.

   ✅ Also computes a `percentage` field per ledger —
   the ledger's share of TOTAL sales across all valid
   (non-excluded) sales ledgers, not just the top 3.
   This makes it directly usable for a pie/donut chart
   on the frontend without any extra math.
=================================================== */
function getTopSellingLedgers(vouchers) {
  const ledgerTotals = {};

  for (const v of vouchers) {
    const voucherType = (getVal(v?.VOUCHERTYPENAME) || "").toString().toLowerCase();
    if (!voucherType.includes("sales")) continue;

    const entries = getLedgerEntries(v);

    for (const e of entries) {
      const ledgerName = getVal(e?.LEDGERNAME);
      if (!ledgerName) continue;
      if (isExcludedLedger(ledgerName)) continue;

      const isDeemedPositive = (getVal(e?.ISDEEMEDPOSITIVE) || "").toString().toLowerCase();
      // Credit side (sales/income ledger) -> ISDEEMEDPOSITIVE is "no"
      const isCreditSide = isDeemedPositive === "no";
      if (!isCreditSide) continue;

      const amount = Math.abs(parseAmount(e?.AMOUNT));

      if (!ledgerTotals[ledgerName]) {
        ledgerTotals[ledgerName] = { ledger_name: ledgerName, total_sales: 0, voucher_count: 0 };
      }
      ledgerTotals[ledgerName].total_sales += amount;
      ledgerTotals[ledgerName].voucher_count += 1;
    }
  }

  const allLedgers = Object.values(ledgerTotals);

  // Grand total across ALL valid sales ledgers (not just top 3) —
  // this is the denominator for percentage calculation.
  const grandTotal = allLedgers.reduce((sum, l) => sum + l.total_sales, 0);

  const topLedgers = allLedgers
    .sort((a, b) => b.total_sales - a.total_sales)
    .slice(0, TOP_LEDGERS_LIMIT)
    .map((item, index) => ({
      rank: index + 1,
      ledger_name: item.ledger_name,
      total_sales: Math.round(item.total_sales * 100) / 100,
      voucher_count: item.voucher_count,
      percentage:
        grandTotal > 0
          ? Math.round((item.total_sales / grandTotal) * 10000) / 100 // 2 decimal places
          : 0
    }));

  return { topLedgers, grandTotal: Math.round(grandTotal * 100) / 100 };
}

/* ===================================================
   ROUTE
   GET /api/v1/top-sales-ledgers?company_id=1
=================================================== */
router.get("/top-sales-ledgers", async (req, res) => {
  try {
    const companyId = req.query.company_id;
    const companyName = req.query.company;

    let companyInfo;

    if (companyId) {
      companyInfo = await getCompanyInfo(companyId, null);
    } else if (companyName) {
      companyInfo = await getCompanyInfo(null, companyName);
    } else {
      return res.status(400).json({
        status: "error",
        message: "company_id or company query parameter is required"
      });
    }

    if (!companyInfo) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    const { id, name: company, yearStart, yearEnd, fyLabel } = companyInfo;

    console.log("COMPANY SENT TO TALLY:", JSON.stringify(company));

    const tallyFrom = yearStart.replace(/-/g, "");
    const tallyTo = yearEnd.replace(/-/g, "");

    const vouchers = await fetchVouchersFromTally(
      company,
      tallyFrom,
      tallyTo
    );

    const { topLedgers, grandTotal } = getTopSellingLedgers(vouchers);

    return res.status(200).json({
      status: "success",
      company_id: id,
      company,
      financial_year: fyLabel,
      financial_year_start: yearStart,
      financial_year_end: yearEnd,
      voucher_count: vouchers.length,
      grand_total_sales: grandTotal,
      top_ledgers_count: topLedgers.length,
      data: topLedgers
    });

  } catch (err) {
    console.error("❌ TOP SALES LEDGERS ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
export default router;