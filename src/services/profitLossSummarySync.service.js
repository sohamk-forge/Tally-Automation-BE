import { getProfitLossReportXML } from "./xmlBuilder.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";

/* ===================================================
   DATE HELPERS
=================================================== */

function getDefaultFinancialYear() {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const from = new Date(fyStartYear, 3, 1);
  return {
    fromISO: toISO(from),
    toISO: toISO(now)
  };
}

// Formats a Date using its LOCAL calendar date, not UTC. Using
// toISOString() here was a bug: it converts to UTC first, which
// shifts local midnight April 1st back to March 31st for any
// server running in a timezone ahead of UTC (e.g. IST, UTC+5:30) —
// this caused the "default" financial-year start to silently come
// out as 2026-03-31 instead of 2026-04-01.
function toISO(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeToISO(dateStr) {
  const s = String(dateStr).trim();
  if (s.includes("-")) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  throw new Error(`Unrecognized date format: ${dateStr}`);
}

function toTallyDate(dateStr) {
  return String(dateStr).replace(/-/g, "");
}

/* ===================================================
   XML PARSING (Tally's raw EXPORTDATA "Profit and Loss")

   Report structure:
   - <DSPDISPNAME>Label</DSPDISPNAME> is a sibling block,
     separate from its amount — the amount for a label
     lives in the NEXT <PLAMT> block that follows it.
   - Group totals (Sales, Direct/Indirect Income, Indirect
     Expenses) live in <BSMAINAMT>.
   - Sub-line breakdowns (Opening Stock, Purchase Accounts,
     Closing Stock) live in <PLSUBAMT> instead.

   IMPORTANT SIGN FIX:
   Tally's own "Cost of Sales :" summary line does NOT
   reliably carry a minus sign in its raw <BSMAINAMT> text
   even when the on-screen report shows "(-)" — that "(-)"
   is a display-only decision Tally applies at render time,
   not always present in the exported number. Trusting that
   single line's sign was the earlier bug.

   THE FIX: derive Cost of Sales ourselves from the three
   PLSUBAMT sub-lines (Opening Stock, Purchases, Closing
   Stock), which DO carry reliable magnitudes. The formula
   below naturally produces the correct sign — verified
   against a real Tally screenshot:
     Opening Stock 53,13,438.53 + Purchases 11,41,587.79
       − Closing Stock 64,74,863.78 = -19,837.46
   which exactly matches Tally's on-screen "(-)19,837.46".
=================================================== */

// Extracts a value from <BSMAINAMT> following a given <DSPDISPNAME> label.
// Scoped to stop at the next <DSPDISPNAME> so it can never grab an amount
// belonging to a different, later section of the report.
function extractMainAmount(xmlString, labelPattern) {
  const pattern = new RegExp(
    `<DSPDISPNAME>\\s*${labelPattern}\\s*:?\\s*<\\/DSPDISPNAME>((?:(?!<DSPDISPNAME>)[\\s\\S])*?)<BSMAINAMT>([\\d,.-]+)<\\/BSMAINAMT>`,
    "i"
  );
  const match = xmlString.match(pattern);
  if (!match) return null;
  return Number(match[2].replace(/,/g, ""));
}

// Same idea, but for sub-line amounts that live in <PLSUBAMT> instead
// (Opening Stock, Purchase Accounts, Closing Stock).
function extractSubAmount(xmlString, labelPattern) {
  const pattern = new RegExp(
    `<DSPDISPNAME>\\s*${labelPattern}\\s*:?\\s*<\\/DSPDISPNAME>((?:(?!<DSPDISPNAME>)[\\s\\S])*?)<PLSUBAMT>([\\d,.-]+)<\\/PLSUBAMT>`,
    "i"
  );
  const match = xmlString.match(pattern);
  if (!match) return null;
  return Number(match[2].replace(/,/g, ""));
}

function parseProfitLossReport(xmlString) {
  // ===== Group totals — read directly from Tally, signs preserved =====
  const totalSales      = extractMainAmount(xmlString, "Sales Accounts?") || 0;
  const directIncome     = extractMainAmount(xmlString, "Direct Incomes?") || 0;
  const indirectIncome   = extractMainAmount(xmlString, "Indirect Incomes?") || 0;
  const indirectExpenses = extractMainAmount(xmlString, "Indirect Expenses?") || 0;

  // ===== Cost of Sales components — magnitudes from PLSUBAMT =====
  const openingStock = Math.abs(extractSubAmount(xmlString, "Opening Stock") || 0);
  const totalPurchase = Math.abs(
    extractSubAmount(xmlString, "Add: Purchase Accounts") ??
    extractSubAmount(xmlString, "Purchase Accounts?") ??
    0
  );
  const closingStock = Math.abs(
    extractSubAmount(xmlString, "Less: Closing Stock") ??
    extractSubAmount(xmlString, "Closing Stock") ??
    0
  );

  // Cost of Sales, correctly signed via arithmetic (not trusted from
  // Tally's own summary line's text, since that sign is unreliable).
 

// Gross Profit
// Formula:
// (Sales - Opening Stock - Purchases + Closing Stock)
// ==========================================
// COST OF SALES
// ==========================================

const costOfSales = Number(
  (openingStock + totalPurchase - closingStock).toFixed(2)
);

// ==========================================
// GROSS PROFIT
// Formula:
// Sales - Opening Stock - Purchases + Closing Stock
// ==========================================

const grossProfit = Number(
  (
    totalSales -
    openingStock -
    totalPurchase +
    closingStock
  ).toFixed(2)
);

// ==========================================
// NET RESULT
// ==========================================

const netResult = Number(
  (grossProfit + indirectIncome - indirectExpenses).toFixed(2)
);

  return {
    totalSales,
    totalPurchase,
    openingStock,
    closingStock,
    directIncome,
    indirectIncome,
    indirectExpenses,
    grossProfit,
    netResult
  };
}

/* ===================================================
   MAIN SYNC FUNCTION
=================================================== */

export async function syncProfitLossSummary(client, { company, companyId, fromDate, toDate, userId }) {
  let fromISO, toISO_;

  if (fromDate && toDate) {
    fromISO = normalizeToISO(fromDate);
    toISO_  = normalizeToISO(toDate);
  } else {
    const defaults = getDefaultFinancialYear();
    fromISO = fromDate ? normalizeToISO(fromDate) : defaults.fromISO;
    toISO_  = toDate ? normalizeToISO(toDate) : defaults.toISO;
  }

  const tallyFrom = toTallyDate(fromISO);
  const tallyTo   = toTallyDate(toISO_);

  const xml = getProfitLossReportXML(company, tallyFrom, tallyTo);
  const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);

  if (!responseXML || responseXML.includes("<ERRORMSG>") || responseXML.includes("Unknown Request")) {
    throw new Error("Tally did not return a valid Profit & Loss report for this period");
  }

  const parsed = parseProfitLossReport(responseXML);

  const resultType = parsed.netResult >= 0 ? "profit" : "loss";

 const profitMarginPercent =
  parsed.totalSales !== 0
    ? Number(((parsed.netResult / parsed.totalSales) * 100).toFixed(2))
    : 0;

  console.log("========== P&L DEBUG (Cost of Sales derived from sub-lines) ==========");
  console.log("totalSales:", parsed.totalSales);
  console.log("openingStock:", parsed.openingStock);
  console.log("totalPurchase:", parsed.totalPurchase);
  console.log("closingStock:", parsed.closingStock);
  console.log("costOfSales (derived):", parsed.openingStock + parsed.totalPurchase - parsed.closingStock);
  console.log("grossProfit:", parsed.grossProfit);
  console.log("indirectIncome:", parsed.indirectIncome);
  console.log("indirectExpenses:", parsed.indirectExpenses);
  console.log("netResult:", parsed.netResult);
  console.log("profitMarginPercent:", profitMarginPercent);
  console.log("========================================================================");

  const guid = `pl_summary_${companyId}_${tallyFrom}_${tallyTo}`;

  const upsert = await client.query(
    `
    INSERT INTO app_test.profit_loss_summary (
      company_id, company_name, from_date, to_date,
      total_sales, total_purchase, opening_stock, closing_stock,
      direct_income, indirect_income, indirect_expenses,
      gross_profit, net_result, result_type, profit_margin_percent,
      guid, master_id, alter_id, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14, $15,
      $16, NULL, 1, NOW(), NOW()
    )
    ON CONFLICT (company_id, from_date, to_date)
    DO UPDATE SET
      company_name           = EXCLUDED.company_name,
      total_sales             = EXCLUDED.total_sales,
      total_purchase          = EXCLUDED.total_purchase,
      opening_stock           = EXCLUDED.opening_stock,
      closing_stock           = EXCLUDED.closing_stock,
      direct_income           = EXCLUDED.direct_income,
      indirect_income         = EXCLUDED.indirect_income,
      indirect_expenses       = EXCLUDED.indirect_expenses,
      gross_profit            = EXCLUDED.gross_profit,
      net_result               = EXCLUDED.net_result,
      result_type              = EXCLUDED.result_type,
      profit_margin_percent   = EXCLUDED.profit_margin_percent,
      guid                     = EXCLUDED.guid,
      alter_id                = app_test.profit_loss_summary.alter_id + 1,
      updated_at               = NOW()
    RETURNING *
    `,
    [
      companyId, company, fromISO, toISO_,
      parsed.totalSales, parsed.totalPurchase, parsed.openingStock, parsed.closingStock,
      parsed.directIncome, parsed.indirectIncome, parsed.indirectExpenses,
      parsed.grossProfit, parsed.netResult, resultType, profitMarginPercent,
      guid
    ]
  );

  const row = upsert.rows[0];

  const totalSalesNum = Number(row.total_sales);
  const grossProfitNum = Number(row.gross_profit);

  const grossProfitPercent =
    totalSalesNum !== 0
      ? Number(((grossProfitNum / totalSalesNum) * 100).toFixed(2))
      : 0;

  return {
    fromDate: fromISO,
    toDate: toISO_,
    totalSales: totalSalesNum,
    totalPurchase: Number(row.total_purchase),
    openingStock: Number(row.opening_stock),
    closingStock: Number(row.closing_stock),
    directIncome: Number(row.direct_income),
    indirectIncome: Number(row.indirect_income),
    indirectExpenses: Number(row.indirect_expenses),
    grossProfit: grossProfitNum,
    grossProfitPercent,
    netResult: Number(row.net_result),
    resultType: row.result_type,
    profitMarginPercent: Number(row.profit_margin_percent)
  };
}