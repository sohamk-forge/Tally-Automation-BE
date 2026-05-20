import express from "express";
import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import {
  getCompaniesXML,
  getLedgersXML,
  getLedgerDetailsXML,
  getGroupSummaryCRXML,
  getGroupSummaryDRXML,
  getGroupSummaryBankXML,
  getLedgerVouchersXML,
  getParentGroupsXML,
  getGroupBalanceXML,
  getAllParentGroupDetailsXML,
  getProfitLossXML,
    getStockGroupSummaryXML
} from "../services/xmlBuilder.js";
import { parseXML } from "../services/parser.js";
import {
  createAuditLog
} from "../utils/createAuditLog.js";



const router = express.Router();

/* ===================================================
   ALLOWED TABLES (SQL INJECTION PROTECTION)
=================================================== */

const allowedTables = [

  "app.companies",
  "app.ledgers",
  "app.sundry_creditors",
  "app.sundry_debtors",
  "app.bank_accounts",
  "app.vouchers",
  "app.parent_groups",
  "app.group_balances",
  "app.all_parent_groups",
  "app.profit_loss",
  "app.stock_group_summary"

];

/* ===================================================
   HELPER FUNCTIONS
=================================================== */

const clean = (value) => {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/&#13;&#10;|\r|\n/g, "")
    .replace(/�/g, "")
    .trim();
};

const cleanBalance = (value) => {
  if (!value) return 0;
  const cleaned = String(value)
    .replace(/[^\d.-]/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return cleaned.length ? Number(cleaned[cleaned.length - 1]) : 0;
};

const parseAmount = (value) => {
  if (!value) return 0;
  const matches = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/g);
  if (!matches?.length) return 0;
  return Number(matches[matches.length - 1]);
};

/* ===================================================
   COMPANY ID HELPER (DRY - NO REPEATED LOOKUPS)
=================================================== */

async function getCompanyId(company, client = null) {
  const dbClient = client || pool;
  const result = await dbClient.query(
    `SELECT id FROM app.companies WHERE name = $1`,
    [company]
  );
  return result.rows[0]?.id || null;
}

/* ===================================================
   CRITICAL FIX: STABLE FALLBACK GUID (NO Date.now())
=================================================== */

const generateFallbackGuid = (company, uniqueValue, type) => {
  return `${type}_${company}_${uniqueValue}`
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase()
    .slice(0, 250);
};

/* ===================================================
   PROPER XML PARSING FOR PROFIT LOSS
=================================================== */

const parseProfitLossFromXML = (xmlString, company, fromDate, toDate) => {
  try {
    const content = typeof xmlString === 'string' ? xmlString : JSON.stringify(xmlString);
    
    let totalSales = 0;
    let totalPurchase = 0;
    let stockValue = 0;
    let indirectIncome = 0;
    let indirectExpenses = 0;
    
    // Extract Sales Accounts
    const salesPattern = /<DSPDISPNAME>Sales Accounts?<\/DSPDISPNAME>[\s\S]*?<BSMAINAMT>([\d,.-]+)<\/BSMAINAMT>/i;
    const salesMatch = content.match(salesPattern);
    if (salesMatch && !salesMatch[0].includes("Total")) {
      totalSales = Math.abs(Number(salesMatch[1].replace(/,/g, '')) || 0);
    }
    
    // Extract Purchase Accounts
    const purchasePattern = /<DSPDISPNAME>Purchase Accounts?<\/DSPDISPNAME>[\s\S]*?<BSMAINAMT>([\d,.-]+)<\/BSMAINAMT>/i;
    const purchaseMatch = content.match(purchasePattern);
    if (purchaseMatch && !purchaseMatch[0].includes("Total")) {
      totalPurchase = Math.abs(Number(purchaseMatch[1].replace(/,/g, '')) || 0);
    }
    
    // Extract Closing Stock
    const stockPattern = /<DSPDISPNAME>Closing Stock<\/DSPDISPNAME>[\s\S]*?<BSMAINAMT>([\d,.-]+)<\/BSMAINAMT>/i;
    const stockMatch = content.match(stockPattern);
    if (stockMatch && !stockMatch[0].includes("Total")) {
      stockValue = Math.abs(Number(stockMatch[1].replace(/,/g, '')) || 0);
    }
    
    // Extract Indirect Incomes
    const incomePattern = /<DSPDISPNAME>Indirect Incomes<\/DSPDISPNAME>[\s\S]*?<BSMAINAMT>([\d,.-]+)<\/BSMAINAMT>/i;
    const incomeMatch = content.match(incomePattern);
    if (incomeMatch && !incomeMatch[0].includes("Total")) {
      indirectIncome = Math.abs(Number(incomeMatch[1].replace(/,/g, '')) || 0);
    }
    
    // Extract Indirect Expenses
    const expensePattern = /<DSPDISPNAME>Indirect Expenses<\/DSPDISPNAME>[\s\S]*?<BSMAINAMT>([\d,.-]+)<\/BSMAINAMT>/i;
    const expenseMatch = content.match(expensePattern);
    if (expenseMatch && !expenseMatch[0].includes("Total")) {
      indirectExpenses = Math.abs(Number(expenseMatch[1].replace(/,/g, '')) || 0);
    }
    
    const grossProfit = totalSales - totalPurchase;
    const netProfit = grossProfit + indirectIncome - indirectExpenses;
    const profitMargin = totalSales > 0 ? Number(((netProfit / totalSales) * 100).toFixed(2)) : 0;
    
    return {
      totalSales,
      totalPurchase,
      stockValue,
      indirectIncome,
      indirectExpenses,
      grossProfit: Number(grossProfit.toFixed(2)),
      netProfit: Number(netProfit.toFixed(2)),
      profitMargin
    };
  } catch (error) {
    console.log("⚠️ Profit Loss parsing error:", error.message);
    return null;
  }
};

/* ===================================================
   UPSERT FUNCTION (FIXED - REMOVED BROKEN ON CONFLICT)
=================================================== */

async function upsertRecord(tableName, guid, masterId, alterId, data, columns, client = null) {
  // SQL INJECTION PROTECTION
  if (!allowedTables.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  
  // Generate stable fallback GUID if missing
  let finalGuid = guid;
  if (!finalGuid && tableName !== 'app.profit_loss') {
    const companyIndex = columns.indexOf('company_name');
    const nameIndex = columns.indexOf('name') !== -1 ? columns.indexOf('name') : 
                      (columns.indexOf('ledger_name') !== -1 ? columns.indexOf('ledger_name') : -1);
    const uniqueValue = nameIndex !== -1 && data[nameIndex] ? data[nameIndex] : 
                       (columns.indexOf('group_name') !== -1 ? data[columns.indexOf('group_name')] : 'unknown');
    finalGuid = generateFallbackGuid(data[companyIndex] || 'unknown', uniqueValue, tableName.replace('app.', ''));
    console.log(`⚠️ Generated stable fallback GUID for ${tableName}: ${finalGuid}`);
  }
  
  if (!finalGuid) {
    console.log(`⚠️ Missing GUID for ${tableName}`);
    return { action: "skipped", reason: "no_guid" };
  }
  
  const dbClient = client || pool;
  
  // CHECK EXISTING
  const existing = await dbClient.query(
    `SELECT id, alter_id FROM ${tableName} WHERE guid = $1`,
    [finalGuid]
  );
  
  // TOTAL COLUMNS = guid(1) + master_id(2) + alter_id(3) + data columns
  const totalColumns = 3 + columns.length;
  const placeholders = Array.from({ length: totalColumns }, (_, i) => `$${i + 1}`).join(", ");
  const values = [finalGuid, masterId || null, alterId || 0, ...data];
  
  // INSERT NEW (Simple INSERT without ON CONFLICT since we already checked)
  if (existing.rows.length === 0) {
    const query = `
      INSERT INTO ${tableName}
      (guid, master_id, alter_id, ${columns.join(", ")}, created_at, updated_at)
      VALUES (${placeholders}, NOW(), NOW())
    `;
    await dbClient.query(query, values);
    return { action: "inserted" };
  }
  
  // COMPARE ALTERID
  const dbAlterId = Number(existing.rows[0]?.alter_id || 0);
  const newAlterId = Number(alterId || 0);
  
  if (newAlterId > dbAlterId) {
    const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(", ");
    const updateValues = [...data, newAlterId, finalGuid];
    const query = `
      UPDATE ${tableName}
      SET ${setClause}, alter_id = $${columns.length + 1}, updated_at = NOW()
      WHERE guid = $${columns.length + 2}
    `;
    await dbClient.query(query, updateValues);
    return { action: "updated", oldAlterId: dbAlterId, newAlterId };
  }
  
  return { action: "ignored", reason: "alter_id_not_newer" };
}

/* ===================================================
   HEALTH API
=================================================== */

router.get("/health", async (req, res) => {
  return res.status(200).json({
    status: "success",
    message: "Sync service healthy",
    services: { api: "running", tally: "ready" },
    timestamp: new Date()
  });
});

/* ===================================================
   COMPANY SYNC (FIXED - HANDLES DUPLICATES)
=================================================== */

router.get("/companies", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const xml = getCompaniesXML();
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const companies = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY || [];
    const list = Array.isArray(companies) ? companies : [companies];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    // Use a Map to deduplicate by name
    const uniqueCompanies = new Map();
    
    for (const item of list) {
      const name = clean(item?.NAME);
      if (!name) continue;
      
      // Keep only the first occurrence of each company name
      if (!uniqueCompanies.has(name)) {
        uniqueCompanies.set(name, item);
      }
    }
    
    for (const [name, item] of uniqueCompanies) {
      const originalGuid = item?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(name, name, 'company');
      const masterId = item?.MASTERID || null;
      const alterId = item?.ALTERID || null;
      const financial_year_start = item?.BOOKSFROM ? String(item.BOOKSFROM).slice(0, 4) : null;
      const financial_year_end = item?.ENDINGAT ? String(item.ENDINGAT).slice(0, 4) : null;
      
      // Check if company already exists by name
      const existingCompany = await client.query(
        `SELECT id, name, guid, alter_id FROM app.companies WHERE name = $1`,
        [name]
      );
      
      if (existingCompany.rows.length === 0) {
        // INSERT new company
        const result = await upsertRecord(
          "app.companies", guid, masterId, alterId,
          [name, financial_year_start, financial_year_end],
          ["name", "financial_year_start", "financial_year_end"],
          client
        );
        if (result.action === "inserted") inserted++;
        else if (result.action === "updated") updated++;
        else ignored++;
      } else {
        // Company exists - check if we should update
        const existingAlterId = Number(existingCompany.rows[0]?.alter_id || 0);
        const newAlterId = Number(alterId || 0);
        
        if (newAlterId > existingAlterId) {
          await client.query(
            `UPDATE app.companies 
             SET financial_year_start = $1, 
                 financial_year_end = $2, 
                 alter_id = $3,
                 updated_at = NOW()
             WHERE name = $4`,
            [financial_year_start, financial_year_end, newAlterId, name]
          );
          updated++;
        } else {
          ignored++;
        }
      }
    }
    
    await client.query("COMMIT");
    
   return res.status(200).json({

  status: "success",

  source: "tally",

  message:
    "Companies synced successfully",

  summary: {

    inserted,

    updated,

    ignored,

    total:
      uniqueCompanies.size

  },

  data:

    Array.from(

      uniqueCompanies.values()

    ).map((item) => ({

      name:
        clean(item?.NAME),

      guid:
        item?.GUID || null,

      master_id:
        item?.MASTERID || null,

      alter_id:
        item?.ALTERID || null,

      financial_year_start:

        item?.BOOKSFROM

          ? String(
              item.BOOKSFROM
            ).slice(0, 4)

          : null,

      financial_year_end:

        item?.ENDINGAT

          ? String(
              item.ENDINGAT
            ).slice(0, 4)

          : null

    }))

});
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ COMPANY SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   LEDGER SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/ledgers", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getLedgersXML(company);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    if (!collection) throw new Error("No ledger collection found");
    
    const ledgerNames = [];
    function extractNames(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) return obj.forEach(extractNames);
      if (typeof obj === "object") {
        if (obj.NAME) ledgerNames.push(String(obj.NAME).trim());
        Object.values(obj).forEach(extractNames);
      }
    }
    extractNames(collection);
    const uniqueLedgers = [...new Set(ledgerNames)];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const ledgerName of uniqueLedgers) {
      try {
        const detailsXML = getLedgerDetailsXML(company, ledgerName);
        const detailsResponse = await sendToTally(detailsXML);
        if (detailsResponse.includes("<ERRORMSG>")) continue;
        
        const detailsParsed = await parseXML(detailsResponse);
        const ledger = detailsParsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.LEDGER;
        if (!ledger) continue;
        
        const originalGuid = ledger?.GUID || null;
        const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'ledger');
        const masterId = ledger?.MASTERID || null;
        const alterId = ledger?.ALTERID || null;
        
        const result = await upsertRecord(
          "app.ledgers", guid, masterId, alterId,
          [
            companyId,
            company,
            clean(ledgerName),
            clean(ledger?.PARENT),
            Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
              ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
              : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
            clean(ledger?.STATENAME),
            clean(ledger?.COUNTRYNAME),
            clean(ledger?.PINCODE),
            clean(ledger?.PARTYGSTIN),
            clean(ledger?.GSTREGISTRATIONTYPE),
            clean(ledger?.INCOMETAXNUMBER),
            clean(ledger?.PHONE),
            clean(ledger?.MOBILE),
            clean(ledger?.EMAIL),
            clean(ledger?.CONTACTPERSON),
            clean(ledger?.OPENINGBALANCE),
            clean(ledger?.CLOSINGBALANCE)
          ],
          [
            "company_id", "company_name", "name", "parent_group", "address", "state", "country",
            "pincode", "gst_number", "gst_type", "pan_number", "phone", "mobile",
            "email", "contact_person", "opening_balance", "closing_balance"
          ],
          client
        );
        
        if (result.action === "inserted") inserted++;
        else if (result.action === "updated") updated++;
        else ignored++;
      } catch (innerErr) {
        console.log("Ledger Error:", ledgerName, innerErr.message);
      }
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Ledgers synced successfully",
      company,
      summary: { inserted, updated, ignored, total: uniqueLedgers.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ LEDGER SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   SUNDRY CREDITORS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/group-summary-cr", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getGroupSummaryCRXML(company);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const ledger of list) {
      const ledgerName = clean(ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME || ledger?.MAILINGNAME);
      if (!ledgerName) continue;
      
      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'creditor');
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;
      const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
      const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);
      
      const result = await upsertRecord(
        "app.sundry_creditors", guid, masterId, alterId,
        [
          companyId,
          company,
          ledgerName,
          "Sundry Creditors",
          Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
          clean(ledger?.$?.ALIAS || ledger?.["@ALIAS"] || ledger?.ALIAS),
          clean(ledger?.STATENAME || ledger?.STATE || ledger?.LEDSTATENAME),
          clean(ledger?.COUNTRYNAME || ledger?.LEDCOUNTRYNAME),
          clean(ledger?.PINCODE),
          clean(ledger?.INCOMETAXNUMBER),
          clean(ledger?.PARTYGSTIN),
          clean(ledger?.GSTREGISTRATIONTYPE),
          clean(ledger?.CONTACTPERSON),
          clean(ledger?.PHONE || ledger?.LEDGERPHONE),
          clean(ledger?.MOBILE || ledger?.LEDGERMOBILE),
          clean(ledger?.FAX),
          clean(ledger?.EMAIL || ledger?.LEDGEREMAIL),
          openingBalance,
          closingBalance,
          openingBalance < 0 ? "Cr" : "Dr",
          closingBalance < 0 ? "Cr" : "Dr"
        ],
        [
          "company_id", "company_name", "ledger_name", "parent_group", "address", "alias", "state",
          "country", "pincode", "pan_number", "gst_number", "gst_registration_type",
          "contact_name", "phone_number", "primary_phone_number", "fax_no", "email",
          "opening_balance", "closing_balance", "opening_balance_type", "closing_balance_type"
        ],
        client
      );
      
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Sundry creditors synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ SUNDRY CREDITORS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   SUNDRY DEBTORS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/group-summary-dr", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getGroupSummaryDRXML(company);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const ledger of list) {
      const ledgerName = clean(ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME || ledger?.MAILINGNAME);
      if (!ledgerName) continue;
      
      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'debtor');
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;
      const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
      const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);
      
      const result = await upsertRecord(
        "app.sundry_debtors", guid, masterId, alterId,
        [
          companyId,
          company,
          ledgerName,
          "Sundry Debtors",
          Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
          clean(ledger?.$?.ALIAS || ledger?.["@ALIAS"] || ledger?.ALIAS),
          clean(ledger?.STATENAME || ledger?.STATE || ledger?.LEDSTATENAME),
          clean(ledger?.COUNTRYNAME || ledger?.LEDCOUNTRYNAME),
          clean(ledger?.PINCODE),
          clean(ledger?.INCOMETAXNUMBER),
          clean(ledger?.PARTYGSTIN),
          clean(ledger?.GSTREGISTRATIONTYPE),
          clean(ledger?.CONTACTPERSON),
          clean(ledger?.PHONE || ledger?.LEDGERPHONE),
          clean(ledger?.MOBILE || ledger?.LEDGERMOBILE),
          clean(ledger?.FAX),
          clean(ledger?.EMAIL || ledger?.LEDGEREMAIL),
          openingBalance,
          closingBalance,
          openingBalance < 0 ? "Cr" : "Dr",
          closingBalance < 0 ? "Cr" : "Dr"
        ],
        [
          "company_id", "company_name", "ledger_name", "parent_group", "address", "alias", "state",
          "country", "pincode", "pan_number", "gst_number", "gst_registration_type",
          "contact_name", "phone_number", "primary_phone_number", "fax_no", "email",
          "opening_balance", "closing_balance", "opening_balance_type", "closing_balance_type"
        ],
        client
      );
      
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Sundry debtors synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ SUNDRY DEBTORS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   BANK ACCOUNTS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/group-summary-bank", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getGroupSummaryBankXML(company);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const ledger of list) {
      const ledgerName = clean(ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME || ledger?.MAILINGNAME);
      if (!ledgerName) continue;
      
      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'bank');
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;
      
      const result = await upsertRecord(
        "app.bank_accounts", guid, masterId, alterId,
        [
          companyId,
          company,
          ledgerName,
          "Bank Accounts",
          clean(ledger?.BANKACCHOLDERNAME),
          clean(ledger?.BANKDETAILS),
          clean(ledger?.IFSCODE),
          clean(ledger?.SWIFTCODE),
          clean(ledger?.BRANCHNAME),
          Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
          clean(ledger?.STATENAME || ledger?.LEDSTATENAME || ledger?.STATE),
          clean(ledger?.COUNTRYNAME),
          clean(ledger?.PINCODE)
        ],
        [
          "company_id", "company_name", "ledger_name", "parent_group", "account_holder_name",
          "account_number", "ifsc_code", "swift_code", "branch", "address",
          "state", "country", "pincode"
        ],
        client
      );
      
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Bank accounts synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ BANK ACCOUNTS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   VOUCHER SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/voucher-sync", async (req, res) => {
  const startTime = Date.now();
  const company = req.query.company;
  const fromDate = req.query.fromDate;
  const toDate = req.query.toDate;
  const voucherType = req.query.voucherType;
  const party = req.query.party;

  /* =========================================
     VALIDATION
  ========================================= */
  if (!company || !fromDate || !toDate) {
    await createAuditLog({
      action: "SYNC_VALIDATION_FAILED",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate },
      logType: "ERROR"
    });
    return res.status(400).json({
      status: "error",
      message: "company, fromDate and toDate required"
    });
  }

  /* =========================================
     SYNC START LOG
  ========================================= */
  await createAuditLog({
    action: "SYNC_START",
    entity: "voucher-sync",
    metadata: { company, fromDate, toDate, voucherType, party }
  });

  const client = await pool.connect();

  try {
    /* =====================================
       TRANSACTION START
    ===================================== */
    await client.query("BEGIN");

    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    /* =====================================
       BUILD XML
    ===================================== */
    const xml = getLedgerVouchersXML(company, fromDate, toDate);

    /* =====================================
       FETCH FROM TALLY
    ===================================== */
    const responseXML = await sendToTally(xml);

    /* =====================================
       XML PARSE
    ===================================== */
    const parsed = await parseXML(responseXML);

    /* =====================================
       COLLECTION
    ===================================== */
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER || [];
    const list = Array.isArray(collection) ? collection : [collection];

    /* =====================================
       TALLY RESPONSE LOG
    ===================================== */
    await createAuditLog({
      action: "TALLY_RESPONSE",
      entity: "voucher-sync",
      metadata: { company, totalRecords: list.length }
    });

    /* =====================================
       COUNTERS
    ===================================== */
    let inserted = 0;
    let updated = 0;
    let ignored = 0;
    let failed = 0;

    /* =====================================
       LOOP
    ===================================== */
    for (const voucher of list) {
      try {
        const voucherNumber = clean(voucher?.VOUCHERNUMBER);
        if (!voucherNumber) continue;

        /* =================================
           LEDGER ENTRIES
        ================================= */
        const entries = voucher?.["ALLLEDGERENTRIES.LIST"];
        const normalized = Array.isArray(entries) ? entries : entries ? [entries] : [];

        /* =================================
           AMOUNTS
        ================================= */
        let debitAmount = 0;
        let creditAmount = 0;
        for (const entry of normalized) {
          const amt = Number(entry?.AMOUNT || 0);
          if (amt < 0) {
            debitAmount += Math.abs(amt);
          } else {
            creditAmount += amt;
          }
        }

        /* ================================
           BASIC VALUES
        ================================= */
        const originalGuid = voucher?.GUID || null;
        const voucherDate = clean(voucher?.DATE)?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
        const voucherTypeName = clean(voucher?.VOUCHERTYPENAME);

        /* ================================
           GUID
        ================================= */
        const guid = originalGuid || generateFallbackGuid(company, `${voucherDate}_${voucherTypeName}_${voucherNumber}`, "voucher");
        const masterId = voucher?.MASTERID || null;
        const alterId = voucher?.ALTERID || 0;
        const partyLedgerName = clean(voucher?.PARTYLEDGERNAME);

        /* ================================
           FILTERS
        ================================= */
        if (voucherType && !voucherTypeName?.toLowerCase().includes(voucherType.toLowerCase())) continue;
        if (party && !partyLedgerName?.toLowerCase().includes(party.toLowerCase())) continue;
/* ================================
   DUPLICATE CHECK
================================ */

const existingVoucher =

  await client.query(

    `
    SELECT id

    FROM app.vouchers

    WHERE company_id = $1
    AND voucher_number = $2
    AND voucher_date = $3
    `,

    [

      companyId,

      voucherNumber,

      voucherDate

    ]

  );

const voucherExists =

  existingVoucher.rows.length > 0;

if (voucherExists) {

  ignored++;

}

/* ================================
   UPSERT
================================ */

if (!voucherExists) {

  const result = await upsertRecord(

    "app.vouchers",

    guid,

    masterId,

    alterId,

    [

      companyId,

      company,

      voucherDate,

      voucherTypeName,

      voucherNumber,

      partyLedgerName,

      clean(voucher?.NARRATION),

      JSON.stringify(normalized),

      debitAmount,

      creditAmount,

      creditAmount - debitAmount

    ],

    [

      "company_id",

      "company_name",

      "voucher_date",

      "voucher_type",

      "voucher_number",

      "party_ledger_name",

      "narration",

      "ledger_entries",

      "debit_amount",

      "credit_amount",

      "balance"

    ],

    client

  );

  if (result.action === "inserted") {

    inserted++;

  } else if (result.action === "updated") {

    updated++;

  }

}
/* ================================
   SALES ITEMS INSERT
================================ */

for (const entry of normalized) {

  const inventoryAllocations =

    entry?.[
      "INVENTORYALLOCATIONS.LIST"
    ];

  const allocations =

    Array.isArray(
      inventoryAllocations
    )

      ? inventoryAllocations

      : inventoryAllocations

      ? [inventoryAllocations]

      : [];

  let cgst = 0;
  let sgst = 0;

  for (const gstEntry of normalized) {

    const ledgerName =

      gstEntry?.LEDGERNAME || "";

    const amount = Math.abs(

      Number(
        gstEntry?.AMOUNT || 0
      )

    );

    if (

      ledgerName
        .toLowerCase()
        .includes("cgst")

    ) {

      cgst += amount;

    }

    if (

      ledgerName
        .toLowerCase()
        .includes("sgst")

    ) {

      sgst += amount;

    }

  }

  for (const item of allocations) {

    await client.query(

      `
      INSERT INTO app.sales_items (

        company_name,

        description,

        actual_quantity,

        billed_quantity,

        billing,

        total_amount

      )

      VALUES (

        $1, $2, $3,
        $4, $5, $6

      )
      `,

      [

        company,

        item?.STOCKITEMNAME || null,

        item?.ACTUALQTY || null,

        item?.BILLEDQTY || null,

        Number(
          (
            cgst + sgst
          ).toFixed(2)
        ),

        Math.abs(
          creditAmount
        )

      ]

    );

  }

}

     
} catch (loopError) {

  failed++;

  await createAuditLog({

    action:
      "VOUCHER_SYNC_RECORD_FAILED",

    entity:
      "voucher-sync",

    metadata: {

      company,

      error:
        loopError.message,

      voucher:
        voucher?.VOUCHERNUMBER

    },

    logType:
      "ERROR"

  });

}
    }

    /* =====================================
       COMMIT
    ===================================== */
    await client.query("COMMIT");

    /* =====================================
       EXECUTION TIME
    ===================================== */
    const executionTime = Date.now() - startTime;

    /* =====================================
       FINAL SUCCESS LOG
    ===================================== */
    await createAuditLog({
      action: "SYNC_COMPLETE",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate, inserted, updated, ignored, failed, totalRecords: list.length, executionTime }
    });

    /* =====================================
       FINAL RESPONSE
    ===================================== */
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Vouchers synced successfully",
      company,
      fromDate,
      toDate,
      summary: { inserted, updated, ignored, failed, total: list.length, executionTime },
      data: list.map((voucher) => ({
        guid: voucher?.GUID || null,
        master_id: voucher?.MASTERID || null,
        alter_id: voucher?.ALTERID || null,
        company_name: company,
        date: clean(voucher?.DATE)?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
        voucher_type: clean(voucher?.VOUCHERTYPENAME),
        voucher_number: clean(voucher?.VOUCHERNUMBER),
        party_ledger_name: clean(voucher?.PARTYLEDGERNAME),
        narration: clean(voucher?.NARRATION),
        ledger_entries: (() => {
          const entries = voucher?.["ALLLEDGERENTRIES.LIST"];
          const normalized = Array.isArray(entries) ? entries : entries ? [entries] : [];
          return normalized;
        })()
      }))
    });
  } catch (err) {
    /* =====================================
       ROLLBACK
    ===================================== */
    await client.query("ROLLBACK");
    /* =====================================
       ERROR LOG
    ===================================== */
    await createAuditLog({
      action: "SYNC_FAILED",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate, error: err.message },
      logType: "ERROR"
    });
    console.log("❌ VOUCHER SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   PARENT GROUPS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/parent-groups", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getParentGroupsXML(company);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP || [];
    const list = Array.isArray(collection) ? collection : collection ? [collection] : [];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const group of list) {
      const groupName = clean(
        group?.NAME ||
        (Array.isArray(group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME)
          ? group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME?.[0]
          : group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME)
      );
      
      if (!groupName) continue;
      
      const originalGuid = group?.GUID || group?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, groupName, 'parentgroup');
      const masterId = group?.MASTERID || group?.$?.MASTERID || null;
      const alterId = group?.ALTERID || group?.$?.ALTERID || null;
      
      const result = await upsertRecord(
        "app.parent_groups", guid, masterId, alterId,
        [companyId, company, groupName],
        ["company_id", "company_name", "group_name"],
        client
      );
      
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Parent groups synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ PARENT GROUPS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   GROUP BALANCES SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/payable-debtors", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({
      status: "error",
      message: "company query parameter required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const getGroupData = async (groupName) => {
      const xml = getGroupBalanceXML(company, groupName);
      const responseXML = await sendToTally(xml);
      const parsed = await parseXML(responseXML);
      const group = parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.GROUP;
      
      const originalGuid = group?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, groupName, 'groupbalance');
      
      return {
        guid: guid,
        masterId: group?.MASTERID || null,
        alterId: group?.ALTERID || null,
        group_name: clean(group?.$?.NAME || group?.["@NAME"] || groupName),
        parent_group: clean(group?.PARENT),
        opening_balance: parseAmount(group?.OPENINGBALANCE),
        closing_balance: parseAmount(group?.CLOSINGBALANCE)
      };
    };
    
    const debtors = await getGroupData("Sundry Debtors");
    const creditors = await getGroupData("Sundry Creditors");
    
    let inserted = 0, updated = 0, ignored = 0;
    
    const debtorsResult = await upsertRecord(
      "app.group_balances", debtors.guid, debtors.masterId, debtors.alterId,
      [companyId, company, debtors.group_name, debtors.parent_group, debtors.opening_balance, debtors.closing_balance],
      ["company_id", "company_name", "group_name", "parent_group", "opening_balance", "closing_balance"],
      client
    );
    
    if (debtorsResult.action === "inserted") inserted++;
    else if (debtorsResult.action === "updated") updated++;
    else ignored++;
    
    const creditorsResult = await upsertRecord(
      "app.group_balances", creditors.guid, creditors.masterId, creditors.alterId,
      [companyId, company, creditors.group_name, creditors.parent_group, creditors.opening_balance, creditors.closing_balance],
      ["company_id", "company_name", "group_name", "parent_group", "opening_balance", "closing_balance"],
      client
    );
    
    if (creditorsResult.action === "inserted") inserted++;
    else if (creditorsResult.action === "updated") updated++;
    else ignored++;
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Group balances synced successfully",
      company,
      summary: { inserted, updated, ignored, total: 2 },
      data: { debtors, creditors }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ GROUP BALANCES ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   ALL PARENT GROUPS DETAILS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/all-parent-groups", async (req, res) => {
  const company = req.query.company;
  const groupName = req.query.groupName;
  
  if (!company || !groupName) {
    return res.status(400).json({
      status: "error",
      message: "company and groupName required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getAllParentGroupDetailsXML(company, groupName);
    const responseXML = await sendToTally(xml);
    const parsed = await parseXML(responseXML);
    
    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];
    
    let inserted = 0, updated = 0, ignored = 0;
    
    for (const ledger of list) {
      const ledgerName = clean(ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME || ledger?.MAILINGNAME);
      if (!ledgerName) continue;
      
      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, `${groupName}_${ledgerName}`, 'allparentgroup');
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;
      const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
      const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);
      
      const result = await upsertRecord(
        "app.all_parent_groups", guid, masterId, alterId,
        [
          companyId,
          company,
          ledgerName,
          groupName,
          Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
          clean(ledger?.STATENAME || ledger?.STATE || ledger?.LEDSTATENAME),
          clean(ledger?.COUNTRYNAME || ledger?.LEDCOUNTRYNAME),
          clean(ledger?.PINCODE),
          clean(ledger?.INCOMETAXNUMBER),
          clean(ledger?.PARTYGSTIN),
          clean(ledger?.GSTREGISTRATIONTYPE),
          clean(ledger?.CONTACTPERSON),
          clean(ledger?.PHONE || ledger?.LEDGERPHONE),
          clean(ledger?.MOBILE || ledger?.LEDGERMOBILE),
          clean(ledger?.FAX),
          clean(ledger?.EMAIL || ledger?.LEDGEREMAIL),
          openingBalance,
          closingBalance,
          openingBalance < 0 ? "Cr" : "Dr",
          closingBalance < 0 ? "Cr" : "Dr"
        ],
        [
          "company_id", "company_name", "ledger_name", "parent_group", "address", "state", "country",
          "pincode", "pan_number", "gst_number", "gst_registration_type", "contact_name",
          "phone_number", "primary_phone_number", "fax_no", "email", "opening_balance",
          "closing_balance", "opening_balance_type", "closing_balance_type"
        ],
        client
      );
      
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "All parent groups details synced successfully",
      company,
      parent_group: groupName,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ ALL PARENT GROUPS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   PROFIT LOSS SYNC (UPDATED WITH company_id)
=================================================== */

router.get("/profit-loss-sync", async (req, res) => {
  const company = req.query.company;
  const fromDate = req.query.fromDate;
  const toDate = req.query.toDate;
  
  if (!company || !fromDate || !toDate) {
    return res.status(400).json({
      status: "error",
      message: "company, fromDate and toDate required"
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Get company_id using helper
    const companyId = await getCompanyId(company, client);
    if (!companyId) {
      throw new Error("Company not found");
    }
    
    const xml = getProfitLossXML(company, fromDate, toDate);
    const responseXML = await sendToTally(xml);
    
    const profitLossData = parseProfitLossFromXML(responseXML, company, fromDate, toDate);
    
    if (!profitLossData) {
      throw new Error("Failed to parse profit loss data from Tally");
    }
    
    const guid = `${companyId}_${fromDate}_${toDate}`;
    const alterId = Date.now();
    
    const result = await upsertRecord(
      "app.profit_loss", guid, null, alterId,
      [
        companyId, company, fromDate, toDate,
        profitLossData.totalSales,
        profitLossData.totalPurchase,
        profitLossData.stockValue,
        profitLossData.grossProfit,
        profitLossData.netProfit,
        profitLossData.profitMargin
      ],
      [
        "company_id", "company_name", "from_date", "to_date", "total_sales", "total_purchase",
        "stock_value", "gross_profit", "net_profit", "profit_margin"
      ],
      client
    );
    
    await client.query("COMMIT");
    
    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Profit loss synced successfully",
      company, fromDate, toDate,
      summary: { action: result.action },
      data: profitLossData
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ PROFIT LOSS SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  } finally {
    client.release();
  }
});

/* ===================================================
   STOCK GROUP SUMMARY SYNC
=================================================== */

router.get(

  "/stock-group-summary-sync",

  async (req, res) => {

    /* =====================================
       COMPANY
    ===================================== */

    const company =
      req.query.company;

    if (!company) {

      return res.status(400).json({

        status: "error",

        message:
          "company required"

      });

    }

    /* =====================================
       DB CLIENT
    ===================================== */

    const client =
      await pool.connect();

    try {

      /* =====================================
         BEGIN TRANSACTION
      ===================================== */

      await client.query("BEGIN");

      /* =====================================
         XML
      ===================================== */

      const xml =

        getStockGroupSummaryXML(
          company
        );

      /* =====================================
         TALLY RESPONSE
      ===================================== */

      const responseXML =

        await sendToTally(xml);

      /* =====================================
         XML PARSE
      ===================================== */

      const parsed =

        await parseXML(
          responseXML
        );

      /* =====================================
         STOCK ITEMS
      ===================================== */

      const stockItems =

        parsed?.ENVELOPE
        ?.BODY
        ?.DATA
        ?.COLLECTION
        ?.STOCKITEM || [];

      const list =

        Array.isArray(stockItems)

          ? stockItems

          : [stockItems];

      /* =====================================
         COUNTERS
      ===================================== */

      let inserted = 0;

      let ignored = 0;

      /* =====================================
         LOOP
      ===================================== */

      for (const item of list) {

        /* =================================
           ITEM NAME
        ================================= */

        const itemName =

          item?.NAME ||

          item?.["@_NAME"] ||

          item?.["$"]?.NAME ||

          item?.["LANGUAGENAME.LIST"]
            ?.["NAME.LIST"]
            ?.NAME ||

          null;

        /* =================================
           GROUP NAME
        ================================= */

        const groupName =

          (item?.PARENT || "")
            .replace("&#4;", "")
            .trim();

        /* =================================
           QUANTITY
        ================================= */

        const quantity =

          parseFloat(
            item?.CLOSINGBALANCE || 0
          ) || 0;

        /* =================================
           STOCK VALUE
        ================================= */

        const stockValue =

          Math.abs(

            parseFloat(
              item?.CLOSINGVALUE || 0
            )

          ) || 0;

        /* =================================
           HSN CODE
        ================================= */

        let hsnCode = null;

        const hsnList =

          item?.["HSNDETAILS.LIST"] || [];

        if (Array.isArray(hsnList)) {

          const validHSN =

            hsnList.find(

              (hsn) => hsn?.HSNCODE

            );

          hsnCode =
            validHSN?.HSNCODE || null;

        } else {

          hsnCode =
            hsnList?.HSNCODE || null;

        }

        /* =================================
           DUPLICATE CHECK
        ================================= */

        const existing =

          await client.query(

            `
            SELECT id

            FROM app.stock_group_summary

            WHERE company_name = $1
            AND item_name = $2
            `,

            [

              company,

              itemName

            ]

          );

        if (

          existing.rows.length > 0

        ) {

          ignored++;

          continue;

        }

        /* =================================
           INSERT
        ================================= */

        await client.query(

          `
          INSERT INTO
          app.stock_group_summary (

            company_name,

            group_name,

            item_name,

            hsn_code,

            quantity,

            stock_value

          )

          VALUES (

            $1, $2, $3, $4, $5, $6

          )
          `,

          [

            company,

            groupName,

            itemName,

            hsnCode,

            quantity,

            stockValue

          ]

        );

        inserted++;

      }

      /* =====================================
         COMMIT
      ===================================== */

      await client.query("COMMIT");

      /* =====================================
         FINAL RESPONSE
      ===================================== */

      return res.status(200).json({

        status: "success",

        source: "tally",

        message:
          "Stock group summary synced successfully",

        company,

        summary: {

          inserted,

          ignored,

          total:
            list.length

        },

        data:

          list.map((item) => ({

            group_name:

              (item?.PARENT || "")
                .replace("&#4;", "")
                .trim(),

            item_name:

              item?.NAME ||

              item?.["@_NAME"] ||

              item?.["$"]?.NAME ||

              item?.["LANGUAGENAME.LIST"]
                ?.["NAME.LIST"]
                ?.NAME ||

              null,

            hsn_code:

              (() => {

                const hsnList =

                  item?.["HSNDETAILS.LIST"] || [];

                if (Array.isArray(hsnList)) {

                  const validHSN =

                    hsnList.find(

                      (hsn) => hsn?.HSNCODE

                    );

                  return (
                    validHSN?.HSNCODE || null
                  );

                }

                return (
                  hsnList?.HSNCODE || null
                );

              })(),

            quantity:

              parseFloat(
                item?.CLOSINGBALANCE || 0
              ) || 0,

            stock_value:

              Math.abs(

                parseFloat(
                  item?.CLOSINGVALUE || 0
                )

              ) || 0

          }))

      });

    } catch (err) {

      /* =====================================
         ROLLBACK
      ===================================== */

      await client.query("ROLLBACK");

      console.log(

        "❌ STOCK GROUP SUMMARY SYNC ERROR:",

        err.message

      );

      return res.status(500).json({

        status: "error",

        message:
          err.message

      });

    } finally {

      /* =====================================
         RELEASE CLIENT
      ===================================== */

      client.release();

    }

  }

);

export default router;