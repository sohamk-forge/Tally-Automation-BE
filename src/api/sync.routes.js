  import express from "express";
    import pool from "../db/index.js";
    import { sendToTallyViaConnector, createConnectorSyncJob, waitForConnectorSyncJob } from "../services/connectorSync.service.js";
    import { resolveUserId } from "../utils/resolveUserId.js";
    import axios from "axios";
    import {
      getCompaniesXML,
        getUnitsXML,
      getLedgersXML,
      getLedgerDetailsXML,
      getGroupSummaryBankXML,
      getLedgerVouchersXML,
      getParentGroupsXML,
      getGroupBalanceXML,
      getAllParentGroupDetailsXML,
      getProfitLossXML,
        getStockGroupSummaryXML,
          getAllLedgersXML,
            getPurchaseSalesLedgersXML,
            getCompanyDetailsXML,
            getCompanyGSTDetailsXML,
            getGodownsXML,
            getSalesGroupXML, getPurchaseGroupXML,
        
    } from "../services/xmlBuilder.js";
    import { parseXML } from "../services/parser.js";
    import {
      createAuditLog
    } from "../utils/createAuditLog.js";
  import { syncProfitLossSummary } from "../services/profitLossSummarySync.service.js";
    import { safeEnqueueSync } from "../queues/sync.queue.js";



const router = express.Router();

/* ===================================================
  AUTH GUARD — single source of truth for every route.
  NEVER trust req.headers['x-user-id'] — that header is
  fully client-controlled and lets any caller impersonate
  any other user. Always resolve identity server-side via
  resolveUserId(req) (session/JWT/etc).
=================================================== */
async function requireUser(req, res) {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ status: "error", message: "Unauthenticated" });
    return null;
  }
  return userId;
}

/* ===================================================
  DELAY UTILITY
=================================================== */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ===================================================
  ALLOWED TABLES (SQL INJECTION PROTECTION)
=================================================== */
const allowedTables = [
  "app_test.companies",
  "app_test.ledgers",
  "app_test.sundry_creditors",
  "app_test.sundry_debtors",
  "app_test.bank_accounts",
  "app_test.vouchers",
  "app_test.parent_groups",
  "app_test.group_balances",
  "app_test.all_parent_groups",
  "app_test.profit_loss",
  "app_test.stock_group_summary",
  "app_test.sales_items",
  "app_test.units",
  "app_test.all_ledger_details",
  "app_test.profit_loss_summary",
  "app_test.company_details",
  "app_test.godown_details"
];

/* ===================================================
  HELPER FUNCTIONS
=================================================== */
const clean = (value) => {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/&#13;&#10;|\r|\n/g, " ")
    .replace(/\s+/g, " ")
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
  COMPANY ID HELPER
=================================================== */
async function getCompanyId(userId, company, client = null) {
  const dbClient = client || pool;
  const result = await dbClient.query(
    `
    SELECT c.id
    FROM app_test.companies c
    JOIN app_test.connector_pairing_tokens cpt
      ON cpt.company_id = c.id
    WHERE cpt.user_id = $1
      AND cpt.is_used = TRUE
      AND c.name = $2
    LIMIT 1
    `,
    [userId, company]
  );
  return result.rows[0]?.id || null;
}

/* ===================================================
  OWNERSHIP HELPER — does this user own/have a paired
  connector for this company? Used to gate every
  company-scoped sync route so one authenticated user
  cannot pull or push data through another user's
  connector/company pairing just by knowing (or guessing)
  a company name.

  ASSUMPTION: app_test.connector_pairing_tokens has
  (user_id, company_id, is_used). This mirrors the
  join already used successfully in /manual-auto.
=================================================== */
async function userOwnsCompany(userId, companyId, client = null) {
  const dbClient = client || pool;
  const result = await dbClient.query(
    `
    SELECT 1
    FROM app_test.connector_pairing_tokens
    WHERE user_id = $1
      AND company_id = $2
      AND is_used = TRUE
    LIMIT 1
    `,
    [userId, companyId]
  );
  return result.rows.length > 0;
}

/* ===================================================
  STABLE FALLBACK GUID
=================================================== */
const generateFallbackGuid = (company, uniqueValue, type) => {
  return `${type}_${company}_${uniqueValue}`
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase()
    .slice(0, 250);
};

/* ===================================================
  UPSERT FUNCTION (PRODUCTION-SAFE)
=================================================== */
let ignoredSameGuid = 0;
let ignoredDifferentGuid = 0;
let guidSourceChanged = 0;

async function upsertRecord(tableName, guid, masterId, alterId, data, columns, client = null) {
  if (!allowedTables.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }

  let finalGuid = guid;
  if (!finalGuid && tableName !== "app_test.profit_loss") {
    const companyIndex = columns.indexOf("company_name");
    const nameIndex = columns.indexOf("name") !== -1 ? columns.indexOf("name") :
      (columns.indexOf("ledger_name") !== -1 ? columns.indexOf("ledger_name") : -1);
    const uniqueValue = nameIndex !== -1 && data[nameIndex] ? data[nameIndex] :
      (columns.indexOf("group_name") !== -1 ? data[columns.indexOf("group_name")] : "unknown");
    finalGuid = generateFallbackGuid(data[companyIndex] || "unknown", uniqueValue, tableName.replace("app_test.", ""));
    console.log(`⚠️ Generated stable fallback GUID for ${tableName}: ${finalGuid}`);
  }

  if (!finalGuid) {
    console.log(`⚠️ Missing GUID for ${tableName}`);
    return { action: "skipped", reason: "no_guid" };
  }

  const dbClient = client || pool;

  const companyIdIndex = columns.indexOf("company_id");
  const hasCompanyIdColumn = companyIdIndex !== -1;
  const companyId = hasCompanyIdColumn ? data[companyIdIndex] : null;

  let existing = { rows: [] };

  if (masterId && (hasCompanyIdColumn ? companyId : true)) {
    existing = hasCompanyIdColumn
      ? await dbClient.query(
          `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE master_id = $1 AND company_id = $2`,
          [masterId, companyId]
        )
      : await dbClient.query(
          `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE master_id = $1`,
          [masterId]
        );
  }

  if (existing.rows.length === 0 && (hasCompanyIdColumn ? companyId : true)) {
    existing = hasCompanyIdColumn
      ? await dbClient.query(
          `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE guid = $1 AND company_id = $2`,
          [finalGuid, companyId]
        )
      : await dbClient.query(
          `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE guid = $1`,
          [finalGuid]
        );
  }

  if (existing.rows.length === 0 && !hasCompanyIdColumn && columns.includes("name")) {
    const nameIndex = columns.indexOf("name");
    const nameValue = data[nameIndex];
    existing = await dbClient.query(
      `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE name = $1`,
      [nameValue]
    );
  }

  if (existing.rows.length === 0) {
    const totalColumns = 3 + columns.length;
    const placeholders = Array.from({ length: totalColumns }, (_, i) => `$${i + 1}`).join(", ");
    const values = [finalGuid, masterId || null, alterId || 0, ...data];

    const query = `
      INSERT INTO ${tableName}
      (guid, master_id, alter_id, ${columns.join(", ")}, created_at, updated_at)
      VALUES (${placeholders}, NOW(), NOW())
    `;
    await dbClient.query(query, values);
    return { action: "inserted" };
  }

  const dbGuid = existing.rows[0]?.guid;
  const dbMasterId = existing.rows[0]?.master_id;
  const dbAlterId = Number(existing.rows[0]?.alter_id || 0);
  const newAlterId = Number(alterId || 0);

  const isSameMaster = String(masterId || "") === String(dbMasterId || "");
  const guidChanged = dbGuid !== finalGuid;

  const ledgerName = columns.includes("ledger_name")
    ? data[columns.indexOf("ledger_name")]
    : (columns.includes("name") ? data[columns.indexOf("name")] : "unknown");

  if (isSameMaster && guidChanged) {
    guidSourceChanged++;
    if (newAlterId < dbAlterId) {
      ignoredDifferentGuid++;
      return { action: "ignored", reason: "guid_changed_old_alterid" };
    }
  } else if (newAlterId <= dbAlterId) {
    const ignoreReason = guidChanged ? "guid_changed_but_different_master" : "alter_id_not_newer";
    if (dbGuid === finalGuid) ignoredSameGuid++;
    else ignoredDifferentGuid++;
    return { action: "ignored", reason: ignoreReason, dbAlterId, newAlterId };
  }

  const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(", ");
  const updateValues = [...data, finalGuid, masterId, newAlterId, existing.rows[0].id];

  await dbClient.query(
    `
    UPDATE ${tableName}
    SET
      ${setClause},
      guid = $${columns.length + 1},
      master_id = $${columns.length + 2},
      alter_id = $${columns.length + 3},
      updated_at = NOW()
    WHERE id = $${columns.length + 4}
    `,
    updateValues
  );

  return { action: "updated", oldAlterId: dbAlterId, newAlterId, guidChanged };
}

function logUpsertSummary() {
  console.log("\n📊 UPSERT SUMMARY STATISTICS:");
  console.log(`  - GUID source changes: ${guidSourceChanged}`);
  console.log(`  - Ignored (same GUID, older alter_id): ${ignoredSameGuid}`);
  console.log(`  - Ignored (different GUID, different master): ${ignoredDifferentGuid}`);
}

/* ===================================================
  HEALTH API
=================================================== */
router.get("/health", async (req, res) => {
  try {
    return res.status(200).json({
      status: "success",
      message: "Sync service healthy",
      services: { api: "running", tally: "connected" },
      timestamp: new Date()
    });
  } catch (err) {
    return res.status(503).json({
      status: "error",
      message: "Tally is not reachable",
      services: { api: "running", tally: "disconnected" },
      error: err.message,
      timestamp: new Date()
    });
  }
});

/* ===================================================
  COMPANY SYNC — discovery, routed through the same
  connector-job queue as every other sync.
=================================================== */
router.get("/companies", async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const xml = getCompaniesXML();
    const responseXML = await discoverCompaniesViaConnector(userId, xml);
    const parsed = await parseXML(responseXML);

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ||
      parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.COMPANY || [];
    const list = Array.isArray(collection) ? collection : collection ? [collection] : [];

    let inserted = 0, updated = 0, ignored = 0;
    const uniqueCompanies = new Map();

    for (const item of list) {
      const name = clean(
        item?.$?.NAME || item?.["@NAME"] || item?.NAME ||
        item?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME
      );
      if (!name) continue;
      if (!uniqueCompanies.has(name)) uniqueCompanies.set(name, item);
    }

    for (const [name, item] of uniqueCompanies) {
      const originalGuid = item?.GUID || item?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(name, name, "company");
      const masterId = item?.MASTERID || item?.$?.MASTERID || null;
      const alterId = item?.ALTERID || item?.$?.ALTERID || null;
      const financial_year_start = item?.STARTINGFROM ? String(item.STARTINGFROM).slice(0, 4) : null;
      const financial_year_end = item?.ENDINGAT ? String(item.ENDINGAT).slice(0, 4) : null;

      const result = await upsertRecord(
        "app_test.companies", guid, masterId, alterId,
        [name, financial_year_start, financial_year_end],
        ["name", "financial_year_start", "financial_year_end"],
        client
      );

      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "connector",
      message: "Companies synced successfully",
      summary: { inserted, updated, ignored, total: uniqueCompanies.size },
      data: Array.from(uniqueCompanies.entries()).map(([name, item]) => ({
        name,
        guid: item?.GUID || item?.$?.GUID || null,
        master_id: item?.MASTERID || item?.$?.MASTERID || null,
        alter_id: item?.ALTERID || item?.$?.ALTERID || null,
        financial_year_start: item?.STARTINGFROM ? String(item.STARTINGFROM).slice(0, 4) : null,
        financial_year_end: item?.ENDINGAT ? String(item.ENDINGAT).slice(0, 4) : null
      }))
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ COMPANY SYNC ERROR:", err.message);
    if (err.message?.startsWith("No connector pairing found")) {
      return res.status(400).json({
        status: "error",
        message: "No paired connector found for this user. Pair a connector before syncing companies."
      });
    }
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  LEDGERS SYNC
=================================================== */
router.get("/ledgers", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ status: "error", message: "company query parameter required" });
  }

  const client = await pool.connect();
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getLedgersXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    if (!collection) throw new Error("No ledger collection found");

    const ledgerNames = [];

    function cleanLedgerName(name) {
      return String(name)
        .replace(/&#13;&#10;/g, " ").replace(/&#13;/g, " ").replace(/&#10;/g, " ")
        .replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " ")
        .replace(/\u200B/g, "").replace(/\u200C/g, "").replace(/\u200D/g, "")
        .replace(/\u00A0/g, " ").replace(/\uFEFF/g, "")
        .replace(/\u2028/g, " ").replace(/\u2029/g, " ")
        .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
    }

    function extractNames(obj) {
      if (!obj) return;
      if (Array.isArray(obj)) { obj.forEach(extractNames); return; }
      if (typeof obj === "object") {
        if (obj.NAME) {
          let ledgerName = typeof obj.NAME === "object" ? obj.NAME?._ || null : String(obj.NAME).trim();
          if (ledgerName && ledgerName !== "[object Object]") {
            ledgerName = cleanLedgerName(ledgerName);
            if (ledgerName) ledgerNames.push(ledgerName);
          }
        }
        Object.values(obj).forEach(extractNames);
      }
    }

    extractNames(collection);
    const uniqueLedgers = [...new Set(ledgerNames)];

    let inserted = 0, updated = 0;
    const failedLedgers = [];

    for (let i = 0; i < uniqueLedgers.length; i++) {
      const ledgerName = uniqueLedgers[i];
      const savepointName = `sp_ledger_${i}`;
      await client.query(`SAVEPOINT ${savepointName}`);

      try {
        const xmlSafeName = ledgerName
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

        let guid = null;
        let gstNumber = null;

        const detailsXML = getLedgerDetailsXML(company, xmlSafeName);
        const detailsResponse = await sendToTallyViaConnector(companyId, detailsXML, "sync", userId);

        if (
          detailsResponse &&
          !detailsResponse.includes("<ERRORMSG>") &&
          !detailsResponse.includes("Unknown Request") &&
          !detailsResponse.includes("<STATUS>0</STATUS>")
        ) {
          const detailsParsed = await parseXML(detailsResponse);

          let ledger =
            detailsParsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER ||
            detailsParsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.LEDGER ||
            detailsParsed?.ENVELOPE?.BODY?.DATA?.LEDGER;

          if (Array.isArray(ledger)) ledger = ledger[0];

          if (ledger?.GUID) {
            guid = typeof ledger.GUID === "object" ? ledger.GUID?._ || null : String(ledger.GUID).trim();
            gstNumber = ledger?.PARTYGSTIN
              ? (typeof ledger.PARTYGSTIN === "object" ? ledger.PARTYGSTIN?._ || null : String(ledger.PARTYGSTIN).trim())
              : null;

            if (!gstNumber) {
              gstNumber =
                ledger?.["LEDGSTREGDETAILS.LIST"]?.GSTIN ||
                ledger?.["LEDGSTREGDETAILS.LIST"]?.REGISTRATIONNUMBER ||
                ledger?.["LEDGSTREGDETAILS.LIST"]?.GSTREGISTRATIONNUMBER ||
                null;
            }
          }
        }

        if (!guid) {
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          failedLedgers.push({ name: ledgerName, reason: "No GUID returned from Tally" });
          continue;
        }

        const result = await upsertRecord(
          "app_test.ledgers", guid, null, null,
          [companyId, company, ledgerName, gstNumber],
          ["company_id", "company_name", "name", "gst_number"],
          client
        );

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);

        if (result.action === "inserted") inserted++;
        else if (result.action === "updated") updated++;

      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        failedLedgers.push({ name: ledgerName, reason: err.message, code: err.code });
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      company,
      summary: {
        total_found: uniqueLedgers.length,
        inserted,
        updated,
        failed: failedLedgers.length,
        first_failure: failedLedgers[0] || null
      }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ LEDGER SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  BANK ACCOUNTS SYNC
=================================================== */
router.get("/group-summary-bank", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ status: "error", message: "company query parameter required" });
  }

  const client = await pool.connect();
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getGroupSummaryBankXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];

    let inserted = 0, updated = 0, ignored = 0;

    for (const ledger of list) {
      const ledgerName = clean(
        ledger?.$?.NAME ||
        ledger?.["@NAME"] ||
        ledger?.NAME ||
        ledger?.MAILINGNAME ||
        ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME
      );
      if (!ledgerName) continue;

      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, ledgerName, "bank");
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;

      const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
      const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);
      const email = clean(ledger?.EMAIL || ledger?.LEDGEREMAIL);
      const phoneNumber = clean(ledger?.PHONE || ledger?.PHONENUMBER || ledger?.LEDGERPHONE);
      const primaryPhoneNumber = clean(ledger?.MOBILE || ledger?.MOBILENUMBER || ledger?.LEDGERMOBILE);
      const gstNumber = clean(ledger?.PARTYGSTIN || ledger?.GSTIN);
      const openingBalanceType = Number(openingBalance) < 0 ? "Dr" : "Cr";
      const closingBalanceType = Number(closingBalance) < 0 ? "Dr" : "Cr";

      const result = await upsertRecord(
        "app_test.bank_accounts", guid, masterId, alterId,
        [
          companyId, company, ledgerName, "Bank Accounts",
          clean(ledger?.BANKACCHOLDERNAME || ledger?.ACHOLDERNAME || ledger?.BankAccHolderName),
          clean(ledger?.BANKACCOUNTNUMBER || ledger?.BANKACCOUNTNO || ledger?.ACCOUNTNUMBER || ledger?.BANKDETAILS),
          clean(ledger?.IFSCCODE || ledger?.IFSCODE),
          clean(ledger?.SWIFTCODE),
          clean(ledger?.BANKNAME),
          clean(ledger?.BANKBRANCHNAME || ledger?.BRANCHNAME),
          Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
          clean(ledger?.STATENAME || ledger?.LEDSTATENAME || ledger?.STATE),
          clean(ledger?.COUNTRYNAME),
          clean(ledger?.PINCODE),
          gstNumber,
          openingBalance, closingBalance, openingBalanceType, closingBalanceType,
          email, phoneNumber, primaryPhoneNumber
        ],
        [
          "company_id", "company_name", "ledger_name", "parent_group",
          "account_holder_name", "account_number", "ifsc_code", "swift_code",
          "bank_name", "branch", "address", "state", "country", "pincode",
          "gst_number", "opening_balance", "closing_balance",
          "opening_balance_type", "closing_balance_type",
          "email", "phone_number", "primary_phone_number"
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
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  VOUCHER SYNC
=================================================== */
router.get("/voucher-sync", async (req, res) => {
  const startTime = Date.now();
  const company = req.query.company;
  const fromDate = req.query.fromDate;
  const toDate = req.query.toDate;
  const voucherType = req.query.voucherType;
  const party = req.query.party;

  if (!company || !fromDate || !toDate) {
    await createAuditLog({
      action: "SYNC_VALIDATION_FAILED",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate },
      logType: "ERROR"
    });
    return res.status(400).json({ status: "error", message: "company, fromDate and toDate required" });
  }

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await createAuditLog({
      action: "SYNC_START",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate, voucherType, party }
    });

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getLedgerVouchersXML(company, fromDate, toDate);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER || [];
    const list = Array.isArray(collection) ? collection : [collection];

    await createAuditLog({
      action: "TALLY_RESPONSE",
      entity: "voucher-sync",
      metadata: { company, totalRecords: list.length }
    });

    let inserted = 0, updated = 0, ignored = 0, failed = 0;

    for (const voucher of list) {
      try {
        const voucherNumber = clean(voucher?.VOUCHERNUMBER);
        if (!voucherNumber) { failed++; continue; }

        const entries = voucher?.["ALLLEDGERENTRIES.LIST"];
        const normalized = Array.isArray(entries) ? entries : entries ? [entries] : [];

        const originalGuid = voucher?.GUID || null;
        const voucherDate = clean(voucher?.DATE)?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
        const voucherTypeName = clean(voucher?.VOUCHERTYPENAME);
        const partyLedgerName = clean(voucher?.PARTYLEDGERNAME);

        let debitAmount = 0;
        let creditAmount = 0;

        const partyEntry = normalized.find(entry => clean(entry?.LEDGERNAME) === partyLedgerName);
        if (partyEntry) {
          const amount = Number(partyEntry?.AMOUNT || 0);
          if (amount < 0) debitAmount = Math.abs(amount);
          else creditAmount = amount;
        }

        const balance = debitAmount - creditAmount;

        if (voucherType && !voucherTypeName?.toLowerCase().includes(voucherType.toLowerCase())) {
          ignored++; continue;
        }
        if (party && !partyLedgerName?.toLowerCase().includes(party.toLowerCase())) {
          ignored++; continue;
        }

        const voucherClient = await pool.connect();

        try {
          await voucherClient.query("BEGIN");

          const guid = originalGuid || generateFallbackGuid(
            company, `${voucherDate}_${voucherTypeName}_${voucherNumber}`, "voucher"
          );
          const masterId = voucher?.MASTERID || null;
          const alterId = voucher?.ALTERID || 0;

          const upsertResult = await voucherClient.query(
            `
            INSERT INTO app_test.vouchers (
              guid, master_id, alter_id, company_id, company_name,
              voucher_date, voucher_type, voucher_number, party_ledger_name,
              narration, ledger_entries, debit_amount, credit_amount, balance,
              created_at, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
            ON CONFLICT (company_id, voucher_number, voucher_date)
            DO UPDATE SET
              voucher_type = EXCLUDED.voucher_type,
              party_ledger_name = EXCLUDED.party_ledger_name,
              narration = EXCLUDED.narration,
              ledger_entries = EXCLUDED.ledger_entries,
              debit_amount = EXCLUDED.debit_amount,
              credit_amount = EXCLUDED.credit_amount,
              balance = EXCLUDED.balance,
              updated_at = NOW()
            RETURNING (xmax = 0) AS was_inserted
            `,
            [
              guid, masterId, alterId, companyId, company,
              voucherDate, voucherTypeName, voucherNumber, partyLedgerName,
              clean(voucher?.NARRATION), JSON.stringify(normalized),
              debitAmount, creditAmount, balance
            ]
          );

          if (upsertResult.rows[0]?.was_inserted) inserted++;
          else updated++;

          for (const entry of normalized) {
            const inventoryAllocations = entry?.["INVENTORYALLOCATIONS.LIST"];
            const allocations = Array.isArray(inventoryAllocations)
              ? inventoryAllocations
              : inventoryAllocations ? [inventoryAllocations] : [];

            if (allocations.length === 0) continue;

            for (const item of allocations) {
              if (!item?.STOCKITEMNAME) continue;

              await voucherClient.query(
                `
                INSERT INTO app_test.sales_items (
                  company_id, company_name, voucher_number, description,
                  actual_quantity, billed_quantity, total_amount,
                  created_at, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
                `,
                [
                  companyId, company, voucherNumber,
                  item?.STOCKITEMNAME || null,
                  parseFloat(String(item?.ACTUALQTY || 0).replace(/[^\d.-]/g, "")),
                  parseFloat(String(item?.BILLEDQTY || 0).replace(/[^\d.-]/g, "")),
                  Math.abs(creditAmount)
                ]
              );
            }
          }

          await voucherClient.query("COMMIT");

        } catch (voucherError) {
          await voucherClient.query("ROLLBACK");
          failed++;
          await createAuditLog({
            action: "VOUCHER_SYNC_RECORD_FAILED",
            entity: "voucher-sync",
            metadata: { company, error: voucherError.message, voucher: voucherNumber },
            logType: "ERROR"
          });
        } finally {
          voucherClient.release();
        }

      } catch (loopError) {
        failed++;
        await createAuditLog({
          action: "VOUCHER_SYNC_RECORD_FAILED",
          entity: "voucher-sync",
          metadata: { company, error: loopError.message, voucher: voucher?.VOUCHERNUMBER },
          logType: "ERROR"
        });
      }
    }

    const executionTime = Date.now() - startTime;

    await createAuditLog({
      action: "SYNC_COMPLETE",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate, inserted, updated, ignored, failed, totalRecords: list.length, executionTime }
    });

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Vouchers synced successfully",
      company, fromDate, toDate,
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
          return Array.isArray(entries) ? entries : entries ? [entries] : [];
        })()
      }))
    });
  } catch (err) {
    await createAuditLog({
      action: "SYNC_FAILED",
      entity: "voucher-sync",
      metadata: { company, fromDate, toDate, error: err.message },
      logType: "ERROR"
    });
    console.log("❌ VOUCHER SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  PARENT GROUPS SYNC
=================================================== */
router.get("/parent-groups", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company required" });

  const client = await pool.connect();
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getParentGroupsXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
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
      const guid = originalGuid || generateFallbackGuid(company, groupName, "parentgroup");
      const masterId = group?.MASTERID || group?.$?.MASTERID || null;
      const alterId = group?.ALTERID || group?.$?.ALTERID || null;

      const result = await upsertRecord(
        "app_test.parent_groups", guid, masterId, alterId,
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
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

    /* ===================================================
      GROUP BALANCES SYNC (UPDATED WITH company_id)
    =================================================== */

/* ===================================================
   GROUP BALANCES SYNC (UPDATED WITH company_id)
=================================================== */
router.get("/payable-debtors", async (req, res) => {
  const company = req.query.company;
  if (!company) {
    return res.status(400).json({ status: "error", message: "company query parameter required" });
  }

  const client = await pool.connect();
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    // ── Existing path: used by Debtors / Creditors / Stock-in-Hand ──
    // These exports come back with a TALLYMESSAGE wrapper.
    const getGroupData = async (groupName) => {
      const xml = getGroupBalanceXML(company, groupName);
      const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
      const parsed = await parseXML(responseXML);
      const group = parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.GROUP;

      const originalGuid = group?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, groupName, 'groupbalance');

      return {
        guid,
        masterId: group?.MASTERID || null,
        alterId: group?.ALTERID || null,
        group_name: clean(group?.$?.NAME || group?.["@NAME"] || groupName),
        parent_group: clean(group?.PARENT),
        opening_balance: parseAmount(group?.OPENINGBALANCE),
        closing_balance: parseAmount(group?.CLOSINGBALANCE)
      };
    };

    // ── New path: used by Sales / Purchase (Collection-type export, ──
    // no TALLYMESSAGE wrapper — path is DATA > COLLECTION > GROUP).
    // Filters on ReservedName in the XML itself to avoid matching
    // stray user-created duplicate groups (e.g. "Sales Account" vs
    // the real reserved "Sales Accounts").
    const getCollectionGroupData = async (xml, fallbackLabel) => {
      const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
      const parsed = await parseXML(responseXML);

      let group = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP;

      // Defensive: if Tally ever returns more than one match, prefer
      // the reserved/built-in group, then any with an actual balance.
      if (Array.isArray(group)) {
        const reservedNameOf = (g) => g?.["@_RESERVEDNAME"] ?? g?.$?.RESERVEDNAME ?? g?.["@RESERVEDNAME"];
        group =
          group.find(g => reservedNameOf(g) === fallbackLabel) ||
          group.find(g => parseAmount(g?.CLOSINGBALANCE) !== null) ||
          group[0];
      }

      const originalGuid = group?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, fallbackLabel, 'groupbalance');

      return {
        guid,
        masterId: group?.MASTERID || null,
        alterId: group?.ALTERID || null,
        group_name: clean(group?.["@_NAME"] ?? group?.$?.NAME ?? group?.["@NAME"] ?? fallbackLabel),
        parent_group: clean(group?.PARENT),
        opening_balance: parseAmount(group?.OPENINGBALANCE),
        closing_balance: parseAmount(group?.CLOSINGBALANCE)
      };
    };

    const debtors   = await getGroupData("Sundry Debtors");
    const creditors = await getGroupData("Sundry Creditors");

    // ── Stock-in-Hand — Tally sometimes stores this group under a ──
    // different spelling ("Stock-in-Hand" vs "Stock in Hand"). Retry
    // the alt spelling if the first comes back empty.
    let stock = await getGroupData("Stock-in-Hand");
    if (!stock.group_name || (!stock.opening_balance && !stock.closing_balance && !stock.guid)) {
      stock = await getGroupData("Stock in Hand");
    }

    // ── Sales & Purchase ─────────────────────────────────────────
    const sales    = await getCollectionGroupData(getSalesGroupXML(company), "Sales Accounts");
    const purchase = await getCollectionGroupData(getPurchaseGroupXML(company), "Purchase Accounts");

    let inserted = 0, updated = 0, ignored = 0;

    const upsertGroup = async (g) => {
      const result = await upsertRecord(
        "app_test.group_balances", g.guid, g.masterId, g.alterId,
        [companyId, company, g.group_name, g.parent_group, g.opening_balance, g.closing_balance],
        ["company_id", "company_name", "group_name", "parent_group", "opening_balance", "closing_balance"],
        client
      );
      if (result.action === "inserted") inserted++;
      else if (result.action === "updated") updated++;
      else ignored++;
    };

    await upsertGroup(debtors);
    await upsertGroup(creditors);
    await upsertGroup(stock);
    await upsertGroup(sales);
    await upsertGroup(purchase);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Group balances synced successfully",
      company,
      summary: { inserted, updated, ignored, total: 5 },
      data: { debtors, creditors, stock, sales, purchase }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ GROUP BALANCES ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
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
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
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
            "app_test.all_parent_groups", guid, masterId, alterId,
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
  PROFIT LOSS SYNC
=================================================== */
router.get("/profit-loss-sync", async (req, res) => {
  const company = req.query.company;
  const fromDate = req.query.fromDate;
  const toDate = req.query.toDate;

  if (!company || !fromDate || !toDate) {
    return res.status(400).json({ status: "error", message: "company, fromDate and toDate required" });
  }

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyResult = await client.query(
      `
      SELECT c.id
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt
        ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND c.name = $2
      LIMIT 1
      `,
      [userId, company]
    );
    const companyId = companyResult.rows[0]?.id;
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getProfitLossXML(company, fromDate, toDate);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const groups = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP || [];
    const list = Array.isArray(groups) ? groups : [groups];

    let totalSales = 0, totalPurchase = 0, directExpenses = 0, directIncomes = 0;
    let stockValue = 0, indirectIncome = 0, indirectExpenses = 0;

    for (const group of list) {
      let rawName =
        group?.["LANGUAGENAME.LIST"]?.[0]?.["NAME.LIST"]?.[0]?.NAME ||
        group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
        group?.NAME;

      let names = [];
      if (Array.isArray(rawName)) names = rawName;
      else if (rawName) names = [rawName];

      let rawBalance = group?.CLOSINGBALANCE;
      if (Array.isArray(rawBalance)) rawBalance = rawBalance[0];
      const balance = Math.abs(Number(rawBalance || 0));

      if (names.some(n => n === "Sales Accounts" || n?.includes("Sales"))) totalSales = balance;
      else if (names.some(n => n === "Purchase Accounts" || n?.includes("Purchase"))) totalPurchase = balance;
      else if (names.some(n => n === "Direct Expenses" || n?.includes("Direct Expenses"))) directExpenses = balance;
      else if (names.some(n => n === "Direct Incomes" || n?.includes("Direct Incomes"))) directIncomes = balance;
      else if (names.some(n => n === "Stock-in-hand" || n?.includes("Stock-in-hand"))) stockValue = balance;
      else if (names.some(n => n === "Indirect Incomes" || n?.includes("Indirect Income"))) indirectIncome = balance;
      else if (names.some(n => n === "Indirect Expenses" || n?.includes("Indirect Expense"))) indirectExpenses = balance;
    }

    const grossProfit = Number((totalSales - totalPurchase - directExpenses + directIncomes).toFixed(2));
    const netProfit = Number((grossProfit + indirectIncome - indirectExpenses).toFixed(2));
    const profitMargin = totalSales > 0 ? Number(((netProfit / totalSales) * 100).toFixed(2)) : 0;

    const profitLossData = {
      totalSales, totalPurchase, directExpenses, directIncomes, stockValue,
      indirectIncome, indirectExpenses, grossProfit, netProfit, profitMargin
    };

    const guid = `${companyId}_${fromDate}_${toDate}`;
    const alterId = 1;

    const result = await upsertRecord(
      "app_test.profit_loss", guid, null, alterId,
      [companyId, company, fromDate, toDate, totalSales, totalPurchase, stockValue, grossProfit, netProfit, profitMargin],
      ["company_id", "company_name", "from_date", "to_date", "total_sales", "total_purchase", "stock_value", "gross_profit", "net_profit", "profit_margin"],
      client
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Profit loss synced successfully",
      company, fromDate, toDate,
      dateRange: { from: formatDate(fromDate), to: formatDate(toDate) },
      summary: { action: result.action },
      data: profitLossData
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ PROFIT LOSS SYNC ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message,
      detail: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  } finally {
    client.release();
  }
});

function formatDate(dateStr) {
  if (dateStr.length === 8) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${day}-${month}-${year}`;
  }
  return dateStr;
}

/* ===================================================
  STOCK GROUP SUMMARY SYNC
=================================================== */
router.get("/stock-group-summary-sync", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getStockGroupSummaryXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const stockItems = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.STOCKITEM || [];
    const list = Array.isArray(stockItems) ? stockItems : [stockItems];

    function extractItemFields(item) {
      let itemName =
        item?.NAME || item?.["@_NAME"] || item?.["$"]?.NAME ||
        item?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME || null;

      if (Array.isArray(itemName)) itemName = itemName[0];
      if (typeof itemName === "object" && itemName !== null) {
        itemName = itemName._ || itemName.NAME || JSON.stringify(itemName);
      }
      itemName = clean(itemName);

      const groupName = (item?.PARENT || "").replace("&#4;", "").trim();
      const unit = clean(item?.BASEUNITS || null);
      const quantity = parseFloat(item?.CLOSINGBALANCE || 0) || 0;
      const rawStockValue = parseFloat(item?.CLOSINGVALUE || 0) || 0;
      const stockValue = rawStockValue * -1;

      let hsnCode = null;
      const hsnList = item?.["HSNDETAILS.LIST"] || [];
      if (Array.isArray(hsnList)) {
        const validHSN = hsnList.find((hsn) => hsn?.HSNCODE);
        hsnCode = validHSN?.HSNCODE || null;
      } else {
        hsnCode = hsnList?.HSNCODE || null;
      }

      let gstRate = 0;
      const gstList = item?.["GSTDETAILS.LIST"] || [];
      const gstArr = Array.isArray(gstList) ? gstList : [gstList];
      const validGST = gstArr.find((g) => g?.GSTRATE || g?.["STATEWISEDETAILS.LIST"]);

      if (validGST) {
        if (validGST.GSTRATE) {
          gstRate = parseFloat(validGST.GSTRATE) || 0;
        } else {
          const stateDetails = validGST["STATEWISEDETAILS.LIST"];
          const stateArr = Array.isArray(stateDetails) ? stateDetails : [stateDetails];
          gstRate = parseFloat(stateArr?.[0]?.RATEOFTAX || stateArr?.[0]?.GSTRATE || 0) || 0;
        }
      }

      const cgstRate = gstRate / 2;
      const sgstRate = gstRate / 2;
      const igstRate = gstRate;

      return { itemName, groupName, unit, quantity, stockValue, hsnCode, gstRate, cgstRate, sgstRate, igstRate };
    }

    let inserted = 0, updated = 0;

    for (const item of list) {
      const { itemName, groupName, unit, quantity, stockValue, hsnCode, gstRate, cgstRate, sgstRate, igstRate } = extractItemFields(item);

      const existing = await client.query(
        `SELECT id FROM app_test.stock_group_summary WHERE company_name = $1 AND item_name = $2`,
        [company, itemName]
      );

      if (existing.rows.length > 0) {
        await client.query(
          `
          UPDATE app_test.stock_group_summary
          SET company_id=$1, group_name=$2, hsn_code=$3, quantity=$4, stock_value=$5,
              unit=$6, gst_rate=$7, cgst_rate=$8, sgst_rate=$9, igst_rate=$10, updated_at=NOW()
          WHERE company_name=$11 AND item_name=$12
          `,
          [companyId, groupName, hsnCode, quantity, stockValue, unit, gstRate, cgstRate, sgstRate, igstRate, company, itemName]
        );
        updated++;
        continue;
      }

      await client.query(
        `
        INSERT INTO app_test.stock_group_summary
        (company_id, company_name, group_name, item_name, hsn_code, quantity, stock_value, unit, gst_rate, cgst_rate, sgst_rate, igst_rate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [companyId, company, groupName, itemName, hsnCode, quantity, stockValue, unit, gstRate, cgstRate, sgstRate, igstRate]
      );
      inserted++;
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Stock group summary synced successfully",
      company,
      summary: { inserted, updated, total: list.length },
      data: list.map((item) => {
        const { itemName, groupName, unit, quantity, stockValue, hsnCode, gstRate, cgstRate, sgstRate, igstRate } = extractItemFields(item);
        return { group_name: groupName, item_name: itemName, hsn_code: hsnCode, quantity, stock_value: stockValue, unit, gst_rate: gstRate, cgst_rate: cgstRate, sgst_rate: sgstRate, igst_rate: igstRate };
      })
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ STOCK GROUP SUMMARY SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  CREATE SYNC JOB — /manual
=================================================== */
router.post("/manual", async (req, res) => {
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const { company, fromYear, toYear } = req.body;

    if (!company || !fromYear || !toYear) {
      return res.status(400).json({ status: "error", message: "Company, fromYear and toYear are required" });
    }

    const trimmedCompany = company.trim();

    const existingCompany = await pool.query(
      `
      SELECT c.id
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt
        ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND c.name = $2
      LIMIT 1
      `,
      [userId, trimmedCompany]
    );

    if (!existingCompany.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Company not found. Sync companies from your paired Tally first."
      });
    }

    const companyId = existingCompany.rows[0].id;
    const owns = await userOwnsCompany(userId, companyId);
    if (!owns) {
      return res.status(403).json({
        status: "error",
        message: "This company is not paired with your account."
      });
    }

    await pool.query(
      `
      UPDATE app_test.companies
      SET financial_year_start = $2,
          financial_year_end = $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [companyId, fromYear, toYear]
    );

    const payload = { company: trimmedCompany, fromYear, toYear };

    const result = await pool.query(
      `
      INSERT INTO app_test.job_logs (job_type, status, payload, user_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      ["manual_sync", "pending", payload, userId]
    );

    const jobLogId = result.rows[0].id;

    await safeEnqueueSync(jobLogId, { jobLogId, company: trimmedCompany, fromYear, toYear, userId });

    return res.status(200).json({
      status: "success",
      message: "Sync job created successfully",
      data: { jobId: jobLogId, company: trimmedCompany, status: "pending" }
    });

  } catch (err) {
    console.log(err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* ===================================================
  DASHBOARD SYNC (AUTO)
  Syncs the company currently opened/selected in dashboard.

  IMPORTANT:
  The dashboard must send:
    {
      "companyId": 12
    }

  We DO NOT select the latest paired company.
  We use the exact companyId selected in the dashboard
  and verify that it belongs to the logged-in user.
=================================================== */
router.post("/manual-auto", async (req, res) => {
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const { companyId } = req.body;

    // -------------------------------------------------
    // VALIDATE COMPANY ID
    // -------------------------------------------------
    const numericCompanyId = Number(companyId);

    if (!companyId || !Number.isInteger(numericCompanyId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid companyId is required"
      });
    }

    // -------------------------------------------------
    // GET THE EXACT SELECTED COMPANY
    // AND VERIFY USER OWNS/IS PAIRED WITH IT
    // -------------------------------------------------
    const companyResult = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.financial_year_start,
        c.financial_year_end
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt
        ON cpt.company_id = c.id
      WHERE c.id = $1
        AND cpt.user_id = $2
        AND cpt.is_used = TRUE
        AND c.financial_year_start IS NOT NULL
        AND c.financial_year_end IS NOT NULL
      ORDER BY cpt.created_at DESC
      LIMIT 1
      `,
      [numericCompanyId, userId]
    );

    if (!companyResult.rows.length) {
      return res.status(403).json({
        status: "error",
        message: "This company is not synced or not paired with your account."
      });
    }

    // -------------------------------------------------
    // EXACT COMPANY SELECTED FROM DASHBOARD
    // -------------------------------------------------
    const {
      id: syncCompanyId,
      name: company_name,
      financial_year_start: from_year,
      financial_year_end: to_year
    } = companyResult.rows[0];

    console.log("===============================================");
    console.log("🔄 DASHBOARD AUTO SYNC");
    console.log("===============================================");
    console.log("User ID       :", userId);
    console.log("Company ID    :", syncCompanyId);
    console.log("Company       :", company_name);
    console.log("From Year     :", from_year);
    console.log("To Year       :", to_year);
    console.log("===============================================");

    // -------------------------------------------------
    // CREATE JOB PAYLOAD
    // -------------------------------------------------
    const payload = {
      company: company_name,
      companyId: syncCompanyId,
      fromYear: from_year,
      toYear: to_year
    };

    // -------------------------------------------------
    // CREATE JOB LOG
    // -------------------------------------------------
    const result = await pool.query(
      `
      INSERT INTO app_test.job_logs
        (job_type, status, payload, user_id)
      VALUES
        ($1, $2, $3, $4)
      RETURNING id
      `,
      [
        "manual_sync",
        "pending",
        payload,
        userId
      ]
    );

    const jobLogId = result.rows[0].id;

    // -------------------------------------------------
    // ADD SYNC JOB TO BULLMQ
    // -------------------------------------------------
    await safeEnqueueSync(jobLogId, {
      jobLogId,
      company: company_name,
      companyId: syncCompanyId,
      fromYear: from_year,
      toYear: to_year,
      userId
    });

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------
    return res.status(200).json({
      status: "success",
      message: "Dashboard sync started successfully.",
      data: {
        jobId: jobLogId,
        companyId: syncCompanyId,
        company: company_name,
        fromYear: from_year,
        toYear: to_year,
        status: "pending"
      }
    });

  } catch (err) {
    console.error(
      "❌ DASHBOARD AUTO SYNC ERROR:",
      err.message
    );

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
/* ===================================================
  UNITS SYNC
=================================================== */
router.get("/units-sync", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getUnitsXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const units = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.UNIT || [];
    const list = Array.isArray(units) ? units : [units];

    let inserted = 0, updated = 0, ignored = 0;

    for (const unit of list) {
      const unitName = clean(unit?.NAME);
      if (!unitName) continue;

      const guid = generateFallbackGuid(company, unitName, "unit");

      const result = await upsertRecord(
        "app_test.units", guid, null, 1,
        [companyId, company, unitName],
        ["company_id", "company_name", "unit_name"],
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
      message: "Units synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ UNITS SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  ALL LEDGERS SYNC
=================================================== */
router.get("/all-ledgers-sync", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getAllLedgersXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(collection) ? collection : [collection];

    let inserted = 0, updated = 0, ignored = 0;
    const insertedLedgers = [];
    const updatedLedgers = [];

    for (const ledger of list) {
      let rawLedgerName =
        ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME || ledger?.MAILINGNAME ||
        ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME;

      if (Array.isArray(rawLedgerName)) rawLedgerName = rawLedgerName[0];

      const ledgerName = clean(rawLedgerName);
      if (!ledgerName) { ignored++; continue; }

      const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
      const guid = originalGuid || generateFallbackGuid(company, ledgerName, "ledger");
      const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
      const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;

      const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
      const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);
      const openingBalanceType = Number(openingBalance) < 0 ? "Dr" : "Cr";
      const closingBalanceType = Number(closingBalance) < 0 ? "Dr" : "Cr";

      const address = Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
        ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
        : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS);

      const phone = clean(ledger?.PHONE || ledger?.LEDGERPHONE);
      const mobile = clean(ledger?.MOBILE || ledger?.LEDGERMOBILE);
      const email = clean(ledger?.EMAIL || ledger?.LEDGEREMAIL);
      const fax = clean(ledger?.FAX);
      const contactPerson = clean(
        ledger?.CONTACTPERSON ||
        ledger?.["CONTACTDETAILS.LIST"]?.CONTACTPERSON ||
        ledger?.["CONTACTDETAILS.LIST"]?.NAME ||
        (Array.isArray(ledger?.["CONTACTDETAILS.LIST"])
          ? (ledger["CONTACTDETAILS.LIST"][0]?.CONTACTPERSON || ledger["CONTACTDETAILS.LIST"][0]?.NAME)
          : null)
      );

      const gstList = ledger?.["LEDGSTREGDETAILS.LIST"];
      const gstNumber = clean(Array.isArray(gstList) ? gstList[0]?.GSTIN : gstList?.GSTIN);
      const panNumber = clean(ledger?.INCOMETAXNUMBER);
      const gstRegistrationType = clean(ledger?.GSTREGISTRATIONTYPE);
      const state = clean(ledger?.STATENAME || ledger?.STATE || ledger?.LEDSTATENAME);
      const country = clean(ledger?.COUNTRYNAME || ledger?.LEDCOUNTRYNAME);
      const pincode = clean(ledger?.PINCODE);
      const parentGroup = clean(ledger?.PARENT || ledger?.GROUPNAME);

      const data = [
        companyId, company, ledgerName, parentGroup, address, state, country, pincode,
        panNumber, gstNumber, gstRegistrationType, contactPerson, phone, mobile, fax, email,
        openingBalance, closingBalance, openingBalanceType, closingBalanceType
      ];

      const columns = [
        "company_id", "company_name", "ledger_name", "parent_group", "address", "state", "country", "pincode",
        "pan_number", "gst_number", "gst_registration_type", "contact_name", "phone_number",
        "primary_phone_number", "fax_no", "email", "opening_balance", "closing_balance",
        "opening_balance_type", "closing_balance_type"
      ];

      const result = await upsertRecord("app_test.all_ledger_details", guid, masterId, alterId, data, columns, client);

      if (result.action === "inserted") {
        inserted++;
        insertedLedgers.push({ name: ledgerName, guid, parent_group: parentGroup, gst_number: gstNumber, has_address: !!address, has_phone: !!(phone || mobile) });
      } else if (result.action === "updated") {
        updated++;
        updatedLedgers.push({ name: ledgerName, guid, parent_group: parentGroup });
      } else {
        ignored++;
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "All ledger details synced successfully",
      company,
      summary: { total_found: list.length, inserted, updated, ignored },
      samples: { inserted: insertedLedgers.slice(0, 5), updated: updatedLedgers.slice(0, 5) },
      data_summary: {
        with_gst: insertedLedgers.filter(l => l.gst_number).length + updatedLedgers.filter(l => l.gst_number).length,
        with_address: insertedLedgers.filter(l => l.has_address).length + updatedLedgers.filter(l => l.has_address).length,
        with_phone: insertedLedgers.filter(l => l.has_phone).length + updatedLedgers.filter(l => l.has_phone).length
      }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ ALL LEDGERS SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  PURCHASE AND SALES LEDGER SYNC
=================================================== */
router.get("/purchase-sales-ledgers-sync", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getPurchaseSalesLedgersXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const ledgers = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
    const list = Array.isArray(ledgers) ? ledgers : [ledgers];

    let inserted = 0, updated = 0, ignored = 0;

    for (const ledger of list) {
      let rawName =
        ledger?.$?.NAME || ledger?.["@NAME"] || ledger?.NAME ||
        ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME || null;

      if (Array.isArray(rawName)) rawName = rawName[0];
      if (typeof rawName === "object" && rawName !== null) rawName = rawName?._ || null;

      const ledgerName = clean(rawName);
      if (!ledgerName) { ignored++; continue; }

      const parentGroup = clean(ledger?.PARENT || ledger?.$?.PARENT || "")?.replace(/&#4;/g, "").trim() || null;
      const normalizedParent = (parentGroup || "").toLowerCase().trim();

      let ledgerType = null;
      if (normalizedParent.includes("purchase")) ledgerType = "PURCHASE";
      else if (normalizedParent.includes("sales")) ledgerType = "SALES";
      else { ignored++; continue; }

      const existing = await client.query(
        `SELECT id FROM app_test.company_purchase_sales_ledgers WHERE company_id = $1 AND ledger_name = $2`,
        [companyId, ledgerName]
      );

      if (existing.rows.length) {
        await client.query(
          `UPDATE app_test.company_purchase_sales_ledgers SET parent_group=$1, ledger_type=$2, updated_at=NOW() WHERE id=$3`,
          [parentGroup, ledgerType, existing.rows[0].id]
        );
        updated++;
      } else {
        await client.query(
          `
          INSERT INTO app_test.company_purchase_sales_ledgers
          (company_id, ledger_name, parent_group, ledger_type, created_at, updated_at)
          VALUES ($1, $2, $3, $4, NOW(), NOW())
          `,
          [companyId, ledgerName, parentGroup, ledgerType]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Purchase/Sales ledgers synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ PURCHASE/SALES LEDGER SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  GODOWN SYNC
=================================================== */
router.get("/godown-sync", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const xml = getGodownsXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", userId);
    const parsed = await parseXML(responseXML);

    const rawGodowns = parsed?.ENVELOPE?.DSPACCNAME || [];
    const list = Array.isArray(rawGodowns) ? rawGodowns : [rawGodowns];

    let inserted = 0, updated = 0, ignored = 0;

    for (const godown of list) {
      let godownName = godown?.DSPDISPNAME || null;
      if (Array.isArray(godownName)) godownName = godownName[0];
      godownName = clean(godownName);
      if (!godownName) { ignored++; continue; }

      const existing = await client.query(
        `SELECT id FROM app_test.godown_details WHERE company_id = $1 AND LOWER(TRIM(godown_name)) = LOWER(TRIM($2)) LIMIT 1`,
        [companyId, godownName]
      );

      if (existing.rows.length) {
        await client.query(`UPDATE app_test.godown_details SET updated_at = NOW() WHERE id = $1`, [existing.rows[0].id]);
        updated++;
      } else {
        await client.query(
          `INSERT INTO app_test.godown_details (company_id, company_name, godown_name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
          [companyId, company, godownName]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Godowns synced successfully",
      company,
      summary: { inserted, updated, ignored, total: list.length }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ GODOWN SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  JOB STATUS BY COMPANY
=================================================== */
router.get("/job-status", async (req, res) => {
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const { companyId } = req.query;
    if (!companyId) {
      return res.status(400).json({ status: "error", message: "companyId is required" });
    }

    const owns = await userOwnsCompany(userId, companyId);
    if (!owns) {
      return res.status(403).json({ status: "error", message: "You do not have access to this company." });
    }

    const result = await pool.query(
      `
      SELECT
          jl.id, jl.job_type, jl.status, jl.created_at, jl.started_at,
          jl.completed_at, jl.error_message,
          c.id as company_id, c.name as company_name
      FROM app_test.job_logs jl
      JOIN app_test.companies c ON c.name = jl.payload->>'company'
      WHERE c.id = $1
        AND jl.user_id = $2
      ORDER BY jl.id DESC
      LIMIT 1
      `,
      [companyId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: "error", message: "No sync job found" });
    }

    return res.status(200).json({ status: "success", data: result.rows[0] });

  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* ===================================================
  JOB STATUS BY ID

  ASSUMPTION: app_test.job_logs has a user_id column
  (added above via the /manual and /manual-auto inserts).
  If that column doesn't exist yet, run:
    ALTER TABLE app_test.job_logs ADD COLUMN user_id INTEGER;
  and backfill historical rows before enforcing NOT NULL.
=================================================== */
router.get("/status/:jobId", async (req, res) => {
  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const { jobId } = req.params;

    const result = await pool.query(
      `
      SELECT id, status, payload, error_message, started_at, completed_at, user_id
      FROM app_test.job_logs
      WHERE id = $1
      `,
      [jobId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: "error", message: "Job not found" });
    }

    const job = result.rows[0];

    if (Number(job.user_id) !== Number(userId)) {
      return res.status(404).json({ status: "error", message: "Job not found" });
    }

    return res.status(200).json({
      status: "success",
      data: {
        jobId: job.id,
        syncStatus: job.status,
        company: job.payload?.company,
        fromYear: job.payload?.fromYear,
        toYear: job.payload?.toYear,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        error: job.error_message,
        message:
          job.status === "completed" ? "Synchronization completed successfully." :
          job.status === "running" ? "Synchronization is in progress." :
          job.status === "failed" ? "Synchronization failed." :
          "Synchronization is pending."
      }
    });

  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* ===================================================
  COMPANY DETAILS
=================================================== */
router.get("/company-details", async (req, res) => {
  const company = req.query.company;
  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const companyXML = getCompanyDetailsXML(company);
    const gstXML = getCompanyGSTDetailsXML(company);

    const [companyJobId, gstJobId] = await Promise.all([
      createConnectorSyncJob(companyId, companyXML, "sync", userId),
      createConnectorSyncJob(companyId, gstXML, "sync", userId)
    ]);

    const [companyResponseXML, gstResponseXML] = await Promise.all([
      waitForConnectorSyncJob(companyJobId, userId),
      waitForConnectorSyncJob(gstJobId, userId)
    ]);

    const companyParsed = await parseXML(companyResponseXML);

    const companyData =
      companyParsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.COMPANY ||
      companyParsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;

    if (!companyData) throw new Error("No company details found in Tally response");

    const readTallyValue = (value) => {
      if (value === undefined || value === null) return null;
      if (typeof value === "string") return value.trim();
      if (typeof value === "object" && value._ !== undefined) return String(value._).trim();
      if (Array.isArray(value)) return value.length ? readTallyValue(value[0]) : null;
      return null;
    };

    const name = readTallyValue(companyData?.NAME) || company;

    let address = null;
    let addressList = companyData?.["ADDRESS.LIST"];
    if (Array.isArray(addressList)) addressList = addressList[0];
    const rawAddresses = addressList?.ADDRESS;
    if (rawAddresses) {
      const addresses = Array.isArray(rawAddresses) ? rawAddresses : [rawAddresses];
      address = addresses.map((item) => readTallyValue(item)).filter(Boolean).join(", ");
    }

    const email = readTallyValue(companyData?.EMAIL);
    const state = readTallyValue(companyData?.STATENAME) || readTallyValue(companyData?.STATE);
    const gstEnabled = String(readTallyValue(companyData?.ISGSTON) || "").trim().toLowerCase() === "yes";

    const gstParsed = await parseXML(gstResponseXML);

    let taxUnits = gstParsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.TAXUNIT || [];
    if (!Array.isArray(taxUnits)) taxUnits = [taxUnits];

    const gstTaxUnit = taxUnits.find((unit) => {
      const attrs = unit?.$ || {};
      const taxType = String(attrs.TAXTYPE || "").trim().toUpperCase();
      const taxRegistration = String(attrs.TAXREGISTRATION || "").trim();
      const gstNumber = readTallyValue(unit?.GSTREGNUMBER);
      return taxType === "GST" || taxRegistration !== "" || gstNumber !== null;
    });

    let gstin = null;
    if (gstTaxUnit) {
      gstin = readTallyValue(gstTaxUnit?.GSTREGNUMBER);
      if (!gstin) gstin = readTallyValue(gstTaxUnit?.$?.TAXREGISTRATION);
    }

    let gstRegistrationDetails = gstTaxUnit?.["GSTREGISTRATIONDETAILS.LIST"] || null;
    if (Array.isArray(gstRegistrationDetails)) gstRegistrationDetails = gstRegistrationDetails[0];

    const registrationType = readTallyValue(gstRegistrationDetails?.REGISTRATIONTYPE);
    const gstState = readTallyValue(gstRegistrationDetails?.STATE) || state;
    const placeOfSupply = readTallyValue(gstRegistrationDetails?.PLACEOFSUPPLY);
    const effectiveFrom = readTallyValue(gstRegistrationDetails?.FROMDATE);
    const gstr1Periodicity = readTallyValue(gstRegistrationDetails?.GSTR1PERIODICITY);

    await client.query(
      `
      INSERT INTO app_test.company_details
      (company_id, company_name, address, state, email, gstin, last_synced_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
      ON CONFLICT (company_id)
      DO UPDATE SET
        company_name = EXCLUDED.company_name,
        address = EXCLUDED.address,
        state = EXCLUDED.state,
        email = EXCLUDED.email,
        gstin = EXCLUDED.gstin,
        last_synced_at = NOW(),
        updated_at = NOW()
      `,
      [companyId, name, address, gstState || state, email, gstin]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      company,
      data: { name, address, email, state: gstState || state, gstEnabled, gstin, registrationType, placeOfSupply, effectiveFrom, gstr1Periodicity }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ COMPANY DETAILS ERROR", err);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  PROFIT & LOSS SUMMARY SYNC
=================================================== */
router.get("/profit-loss-summary-sync", async (req, res) => {
  const company = req.query.company;
  const fromDate = req.query.fromDate || null;
  const toDate = req.query.toDate || null;

  if (!company) return res.status(400).json({ status: "error", message: "company query parameter required" });

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    await client.query("BEGIN");

    const companyId = await getCompanyId(userId, company, client);
    if (!companyId) throw new Error("Company not found");

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "This company is not paired with your account." });
    }

    const summary = await syncProfitLossSummary(client, { company, companyId, fromDate, toDate, userId });

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      source: "tally",
      message: "Profit & loss summary synced successfully",
      company,
      data: summary
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("❌ PROFIT LOSS SUMMARY SYNC ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
  PROFIT MARGIN
=================================================== */
router.get("/profit-margin", async (req, res) => {
  const companyId = Number(req.query.company_id);
  const fromDate = req.query.fromDate || null;
  const toDate = req.query.toDate || null;

  if (!companyId) {
    return res.status(400).json({ status: "error", message: "company_id query parameter required" });
  }

  const client = await pool.connect();

  try {
    const userId = await requireUser(req, res);
    if (!userId) return;

    const owns = await userOwnsCompany(userId, companyId, client);
    if (!owns) {
      return res.status(403).json({ status: "error", message: "You do not have access to this company." });
    }

    const companyResult = await client.query(
      `SELECT name AS company_name FROM app_test.companies WHERE id = $1`,
      [companyId]
    );

    if (companyResult.rows.length === 0) throw new Error("Company not found");

    const company = companyResult.rows[0].company_name;

    let query, params;
    if (fromDate && toDate) {
      query = `SELECT * FROM app_test.profit_loss_summary WHERE company_id = $1 AND from_date = $2 AND to_date = $3`;
      params = [companyId, fromDate, toDate];
    } else {
      query = `SELECT * FROM app_test.profit_loss_summary WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 1`;
      params = [companyId];
    }

    let existing = await client.query(query, params);

    if (existing.rows.length === 0 || (fromDate && toDate)) {
      await client.query("BEGIN");
      await syncProfitLossSummary(client, { company, companyId, fromDate, toDate, userId });
      await client.query("COMMIT");
      existing = await client.query(query, params);
    }

    const row = existing.rows[0];
    if (!row) {
      return res.status(404).json({ status: "error", message: "No profit & loss summary available." });
    }

    const totalSalesNum = Number(row.total_sales);
    const grossProfitNum = Number(row.gross_profit);
    const grossProfitPercent = totalSalesNum > 0 ? Number(((grossProfitNum / totalSalesNum) * 100).toFixed(2)) : 0;

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      fromDate: row.from_date,
      toDate: row.to_date,
      totalSales: totalSalesNum,
      grossProfit: grossProfitNum,
      grossProfitPercent,
      netResult: Number(row.net_result),
      resultType: row.result_type,
      profitMarginPercent: Number(row.profit_margin_percent),
      lastSyncedAt: row.updated_at
    });

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.log("❌ PROFIT MARGIN ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  } finally {
    client.release();
  }
});
export default router;
