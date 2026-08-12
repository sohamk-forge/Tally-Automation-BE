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

function toISO(d) {
  return d.toISOString().slice(0, 10);
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

   IMPORTANT — how this report is actually structured:
   - <DSPDISPNAME>Label</DSPDISPNAME> is a SEPARATE sibling
     block from its amount, not a nested container. The
     amount for a given label lives in the NEXT <PLAMT>
     block that follows it.
   - Group totals (Sales, Direct/Indirect Income, Indirect
     Expenses, and Tally's own computed "Cost of Sales :"
     line) live in <BSMAINAMT>.
   - Sub-line breakdowns (Opening Stock, Purchase Accounts,
     Closing Stock — the components Tally used to compute
     "Cost of Sales :") live in <PLSUBAMT> instead, and
     <BSMAINAMT> is empty for those rows.
   - This export mode does NOT include "Gross Profit" or
     "Nett Profit" as their own lines at all — those only
     appear in Tally's on-screen view, not in this raw XML.
     So we no longer search for them.

   THE FIX: instead of manually re-deriving Cost of Sales
   from Opening Stock + Purchases − Closing Stock (which is
   fragile and was the source of earlier bugs), we read
   Tally's own already-computed "Cost of Sales :" line
   directly — literally extracting the number Tally itself
   calculated, not recomputing it ourselves.
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

// Same idea, but for sub-line amounts that live in <PLSUBAMT> instead.
// Used only for informational/display fields (Opening Stock, Purchase
// Accounts, Closing Stock) — NOT used to compute Gross Profit anymore.
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
  const totalSales       = extractMainAmount(xmlString, "Sales Accounts?") || 0;
  const directIncome      = extractMainAmount(xmlString, "Direct Incomes?") || 0;
  const costOfSales       = extractMainAmount(xmlString, "Cost of Sales") ?? 0;
  const indirectIncome    = extractMainAmount(xmlString, "Indirect Incomes?") || 0;
  const indirectExpenses  = extractMainAmount(xmlString, "Indirect Expenses?") || 0;

  // ===== Informational sub-lines only (not used in the calc below) =====
  const openingStock = Math.abs(extractSubAmount(xmlString, "Opening Stock") || 0);
  const totalPurchase = Math.abs(extractSubAmount(xmlString, "Add: Purchase Accounts") ?? extractSubAmount(xmlString, "Purchase Accounts?") ?? 0);
  const closingStock = Math.abs(extractSubAmount(xmlString, "Less: Closing Stock") ?? extractSubAmount(xmlString, "Closing Stock") ?? 0);

  // ===== Gross Profit / Net Result — using Tally's own Cost of Sales
  //       line directly, exactly the way Tally itself computes it on
  //       screen (Sales + Direct Income − Cost of Sales, then
  //       + Indirect Income − Indirect Expenses). No re-derivation
  //       from Opening/Purchase/Closing Stock. =====
  const grossProfit = Number((totalSales + directIncome - costOfSales).toFixed(2));
  const netResult    = Number((grossProfit + indirectIncome - indirectExpenses).toFixed(2));

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

  console.log("========== P&L DEBUG (from Tally's own Cost of Sales line) ==========");
  console.log("totalSales:", parsed.totalSales);
  console.log("directIncome:", parsed.directIncome);
  console.log("costOfSales (derived internally, not stored):", parsed.totalSales + parsed.directIncome - parsed.grossProfit);
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