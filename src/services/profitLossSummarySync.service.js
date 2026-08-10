import { getProfitLossReportXML } from "./xmlBuilder.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";

/* ===================================================
   DATE HELPERS
=================================================== */

// Default period = current financial year (1 Apr → today), India-style FY.
// If your books run on a different FY, just pass fromDate/toDate explicitly.
function getDefaultFinancialYear() {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // April = month index 3
  const from = new Date(fyStartYear, 3, 1);
  return {
    fromISO: toISO(from),
    toISO: toISO(now)
  };
}

function toISO(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Accepts "2024-04-01" OR "20240401" → returns "2024-04-01"
function normalizeToISO(dateStr) {
  const s = String(dateStr).trim();
  if (s.includes("-")) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  throw new Error(`Unrecognized date format: ${dateStr}`);
}

// Accepts "2024-04-01" OR "20240401" → returns "20240401" (Tally format)
function toTallyDate(dateStr) {
  return String(dateStr).replace(/-/g, "");
}

/* ===================================================
   XML PARSING (Tally's on-screen P&L report)
=================================================== */

function extractAmount(xmlString, labelPattern) {
  const pattern = new RegExp(
    `<DSPDISPNAME>\\s*${labelPattern}\\s*<\\/DSPDISPNAME>[\\s\\S]*?<BSMAINAMT>([\\d,.-]+)<\\/BSMAINAMT>`,
    "i"
  );
  const match = xmlString.match(pattern);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

function parseProfitLossReport(xmlString) {
  const totalSales      = Math.abs(extractAmount(xmlString, "Sales Accounts?") || 0);
  const totalPurchase   = Math.abs(extractAmount(xmlString, "Purchase Accounts?") || 0);
  const openingStock    = Math.abs(extractAmount(xmlString, "Opening Stock") || 0);
  const closingStock    = Math.abs(extractAmount(xmlString, "Closing Stock") || 0);
  const directExpenses  = Math.abs(extractAmount(xmlString, "Direct Expenses") || 0);
  const directIncome    = Math.abs(extractAmount(xmlString, "Direct Incomes?") || 0);
  const indirectIncome  = Math.abs(extractAmount(xmlString, "Indirect Incomes?") || 0);
  const indirectExpenses = Math.abs(extractAmount(xmlString, "Indirect Expenses?") || 0);

  // Prefer Tally's own computed Gross/Nett Profit or Loss lines when present —
  // more reliable than re-deriving them, since Tally already applied its own
  // adjustments (stock valuation methods, rounding, etc).
  const grossProfitLine = extractAmount(xmlString, "Gross Profit");
  const grossLossLine   = extractAmount(xmlString, "Gross Loss");
  const nettProfitLine  = extractAmount(xmlString, "Nett Profit") ?? extractAmount(xmlString, "Net Profit");
  const nettLossLine    = extractAmount(xmlString, "Nett Loss") ?? extractAmount(xmlString, "Net Loss");

  let grossProfit;
  if (grossProfitLine != null) grossProfit = Math.abs(grossProfitLine);
  else if (grossLossLine != null) grossProfit = -Math.abs(grossLossLine);
  else grossProfit = (totalSales + closingStock + directIncome) - (totalPurchase + openingStock + directExpenses);

  let netResult;
  if (nettProfitLine != null) netResult = Math.abs(nettProfitLine);
  else if (nettLossLine != null) netResult = -Math.abs(nettLossLine);
  else netResult = grossProfit + indirectIncome - indirectExpenses;

  return {
    totalSales,
    totalPurchase,
    openingStock,
    closingStock,
    directIncome,
    indirectIncome,
    indirectExpenses,
    grossProfit: Number(grossProfit.toFixed(2)),
    netResult: Number(netResult.toFixed(2))
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

  /* =====================================
     NET PROFIT MARGIN %
     Uncapped, signed. A loss CAN exceed
     100% of sales — that's a valid real
     result, not a bug. Stored in the
     existing profit_margin_percent column.
  ===================================== */
  const profitMarginPercent =
    parsed.totalSales > 0
      ? Number(((parsed.netResult / parsed.totalSales) * 100).toFixed(2))
      : 0;

  console.log("========== P&L DEBUG ==========");
  console.log("totalSales:", parsed.totalSales);
  console.log("grossProfit:", parsed.grossProfit);
  console.log("netResult:", parsed.netResult);
  console.log("profitMarginPercent (net):", profitMarginPercent);
  console.log("================================");

  const guid = `pl_summary_${companyId}_${tallyFrom}_${tallyTo}`;

  // NOTE: gross_profit_percent is NOT a column in this table —
  // we don't insert/select it. It's derived on the fly below,
  // from gross_profit / total_sales, which already exist as columns.
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

  // Derived at read time — no DB column needed for this.
  const grossProfitPercent =
    totalSalesNum > 0
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