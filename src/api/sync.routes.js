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
            getGodownsXML
        
    } from "../services/xmlBuilder.js";
    import { parseXML } from "../services/parser.js";
    import {
      createAuditLog
    } from "../utils/createAuditLog.js";
  import { syncProfitLossSummary } from "../services/profitLossSummarySync.service.js";
    import {
      syncQueue,
      getSyncJobId,
      SYNC_JOB_OPTIONS
    } from "../queues/sync.queue.js";



    const router = express.Router();

    /* ===================================================
      DELAY UTILITY
    =================================================== */

    const delay = (ms) =>

      new Promise(

        (resolve) =>

          setTimeout(resolve, ms)

      );

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
        .replace(/&#13;&#10;|\r|\n/g, "")
        .replace(/ /g, "")
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
        `SELECT id FROM app_test.companies WHERE name = $1`,
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
      UPSERT FUNCTION (PRODUCTION-SAFE)
    =================================================== */

  // Add counters at the top of your file for monitoring
  let ignoredSameGuid = 0;
  let ignoredDifferentGuid = 0;
  let guidSourceChanged = 0;

  async function upsertRecord(tableName, guid, masterId, alterId, data, columns, client = null) {
    // SQL INJECTION PROTECTION
    if (!allowedTables.includes(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    
    // Generate stable fallback GUID if missing
    let finalGuid = guid;
    if (!finalGuid && tableName !== 'app_test.profit_loss') {
      const companyIndex = columns.indexOf('company_name');
      const nameIndex = columns.indexOf('name') !== -1 ? columns.indexOf('name') : 
                        (columns.indexOf('ledger_name') !== -1 ? columns.indexOf('ledger_name') : -1);
      const uniqueValue = nameIndex !== -1 && data[nameIndex] ? data[nameIndex] : 
                        (columns.indexOf('group_name') !== -1 ? data[columns.indexOf('group_name')] : 'unknown');
      finalGuid = generateFallbackGuid(data[companyIndex] || 'unknown', uniqueValue, tableName.replace('app_test.', ''));
      console.log(`⚠️ Generated stable fallback GUID for ${tableName}: ${finalGuid}`);
    }
    
    if (!finalGuid) {
      console.log(`⚠️ Missing GUID for ${tableName}`);
      return { action: "skipped", reason: "no_guid" };
    }
    
    const dbClient = client || pool;
    
  const companyIdIndex = columns.indexOf("company_id");
    const hasCompanyIdColumn = companyIdIndex !== -1;

    const companyId =
      hasCompanyIdColumn
        ? data[companyIdIndex]
        : null;

    console.log("DEBUG companyId:", companyId, "hasCompanyIdColumn:", hasCompanyIdColumn);

    // CHECK EXISTING BY MASTER ID FIRST
    let existing = { rows: [] };

    if (masterId && (hasCompanyIdColumn ? companyId : true)) {
      existing = hasCompanyIdColumn
        ? await dbClient.query(
            `
            SELECT id, guid, master_id, alter_id
            FROM ${tableName}
            WHERE master_id = $1
              AND company_id = $2
            `,
            [masterId, companyId]
          )
        : await dbClient.query(
            `
            SELECT id, guid, master_id, alter_id
            FROM ${tableName}
            WHERE master_id = $1
            `,
            [masterId]
          );
    }

    // FALLBACK TO GUID (only if no master_id match)
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

    // FALLBACK TO NAME (only for tables with no company_id, e.g. companies — name is the real unique key)
    if (existing.rows.length === 0 && !hasCompanyIdColumn && columns.includes("name")) {
      const nameIndex = columns.indexOf("name");
      const nameValue = data[nameIndex];
      existing = await dbClient.query(
        `SELECT id, guid, master_id, alter_id FROM ${tableName} WHERE name = $1`,
        [nameValue]
      );
    }


    // INSERT NEW RECORD
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
    
    // EXISTING RECORD FOUND - CHECK UPDATE CONDITIONS
    const dbGuid = existing.rows[0]?.guid;
    const dbMasterId = existing.rows[0]?.master_id;
    const dbAlterId = Number(existing.rows[0]?.alter_id || 0);
    const newAlterId = Number(alterId || 0);
    
    const isSameMaster = String(masterId || "") === String(dbMasterId || "");
    const guidChanged = dbGuid !== finalGuid;
    
    // DEBUG LOGGING
    const ledgerName =
    columns.includes("ledger_name")
      ? data[columns.indexOf("ledger_name")]
      : (
          columns.includes("name")
            ? data[columns.indexOf("name")]
            : "unknown"
        );
    
    console.log("🔍 UPDATE CHECK:", {
      table: tableName,
      ledger: ledgerName,
      masterId,
      dbMasterId,
      isSameMaster,
      dbGuid,
      tallyGuid: finalGuid,
      guidChanged,
      dbAlterId,
      newAlterId
    });
    
    // PRODUCTION-SAFE UPDATE LOGIC
    
    // Case 1: Same master_id but GUID changed (different Tally source)
  // Case 1: Same master_id but GUID changed
  if (isSameMaster && guidChanged) {

    console.log("⚠️ GUID SOURCE CHANGED", {
      table: tableName,
      ledger: ledgerName,
      masterId,
      oldGuid: dbGuid,
      newGuid: finalGuid,
      oldAlterId: dbAlterId,
      newAlterId
    });

    guidSourceChanged++;

    // Production Safety:
    // Don't overwrite newer data with older alter_id

    if (newAlterId < dbAlterId) {

      console.log("🚨 IGNORED RECORD", {
        table: tableName,
        ledger: ledgerName,
        reason: "guid_changed_old_alterid",
        dbAlterId,
        newAlterId
      });

      ignoredDifferentGuid++;

      return {
        action: "ignored",
        reason: "guid_changed_old_alterid"
      };
    }
  }
    // Case 2: Normal alter_id comparison (same GUID or different master_id)
  else if (newAlterId <= dbAlterId) {
      // LOG IGNORED RECORDS FOR DEBUGGING
      const ignoreReason = guidChanged ? "guid_changed_but_different_master" : "alter_id_not_newer";
      
      console.log("🚨 IGNORED RECORD", {
        table: tableName,
        ledger: ledgerName,
        masterId,
        dbMasterId,
        dbGuid,
        tallyGuid: finalGuid,
        dbAlterId,
        newAlterId,
        reason: ignoreReason
      });
      
      if (dbGuid === finalGuid) {
        ignoredSameGuid++;
      } else {
        ignoredDifferentGuid++;
      }
      
      return {
        action: "ignored",
        reason: ignoreReason,
        dbAlterId,
        newAlterId
      };
    }
    
    // PERFORM UPDATE (reached only if conditions are met)
    const setClause = columns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(", ");
    
    const updateValues = [
      ...data,
      finalGuid,
      masterId,
      newAlterId,
      existing.rows[0].id
    ];
    
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
    
    console.log("✅ UPDATED:", {
      table: tableName,
      ledger: ledgerName,
      masterId,
      guid: finalGuid,
      alterId: newAlterId,
      guidChanged: guidChanged,
      alterIdChanged: newAlterId !== dbAlterId
    });
    
    return {
      action: "updated",
      oldAlterId: dbAlterId,
      newAlterId,
      guidChanged
    };
  }

  // Function to log summary statistics after sync completes
  function logUpsertSummary() {
    console.log("\n📊 UPSERT SUMMARY STATISTICS:");
    console.log(`  - GUID source changes: ${guidSourceChanged}`);
    console.log(`  - Ignored (same GUID, older alter_id): ${ignoredSameGuid}`);
    console.log(`  - Ignored (different GUID, different master): ${ignoredDifferentGuid}`);
  }

    /* ===================================================
      HEALTH API
    =================================================== */

  /* ===================================================
    HEALTH API
  =================================================== */

  router.get("/health", async (req, res) => {

      try {

          return res.status(200).json({
              status: "success",
              message: "Sync service healthy",
              services: {
                  api: "running",
                  tally: "connected"
              },
              timestamp: new Date()
          });

      } catch (err) {

          return res.status(503).json({
              status: "error",
              message: "Tally is not reachable",
              services: {
                  api: "running",
                  tally: "disconnected"
              },
              error: err.message,
              timestamp: new Date()
          });

      }

  });

    /* ===================================================
      COMPANY SYNC (FIXED - HANDLES DUPLICATES)
    =================================================== */
  router.get(
    "/companies",
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { user_id } = req.query;

        /* =====================================
          RESOLVE CONNECTOR URL FOR THIS USER
        ===================================== */
        /* =====================================
          CONNECTOR URL (LOCAL DEV — NO DB LOOKUP)
        ===================================== */
        const connectorUrl = "http://localhost:5002";

        /* =====================================
          FETCH COMPANIES FROM CONNECTOR (JSON, NOT XML)
        ===================================== */
        const connectorResponse = await axios.get(
          `${connectorUrl}/api/connector/companies`,
          { timeout: 30000 }
        );

        const companies = connectorResponse.data?.data || [];
        const list = Array.isArray(companies) ? companies : [companies];

        let inserted = 0, updated = 0, ignored = 0;

        const uniqueCompanies = new Map();

        for (const item of list) {
          const name = clean(item?.name);
          if (!name) continue;

          if (!uniqueCompanies.has(name)) {
            uniqueCompanies.set(name, item);
          }
        }

  for (const [name, item] of uniqueCompanies) {
          const guid = item?.guid || generateFallbackGuid(name, name, 'company');
          const masterId = item?.masterId || null;
          const alterId = item?.alterId || null;
          const financial_year_start = item?.booksFrom ? String(item.booksFrom).slice(0, 4) : null;
          const financial_year_end = item?.endingAt ? String(item.endingAt).slice(0, 4) : null;

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
          data: Array.from(uniqueCompanies.values()).map((item) => ({
            name: clean(item?.name),
            guid: item?.guid || null,
            master_id: item?.masterId || null,
            alter_id: item?.alterId || null,
            financial_year_start: item?.booksFrom ? String(item.booksFrom).slice(0, 4) : null,
            financial_year_end: item?.endingAt ? String(item.endingAt).slice(0, 4) : null
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
    }
  );

    router.get("/ledgers", async (req, res) => {
      const company = req.query.company;
      if (!company) {
        return res.status(400).json({ status: "error", message: "company query parameter required" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const companyId = await getCompanyId(company, client);
        if (!companyId) throw new Error("Company not found");

        const xml = getLedgersXML(company);
    const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);

    console.log("");
    console.log("=================================");
    console.log("RAW XML RESPONSE");
    console.log("=================================");
    console.log(responseXML);

    const parsed = await parseXML(responseXML);

    console.log("");
    console.log("=================================");
    console.log("PARSED RESPONSE");
    console.log("=================================");
    console.log(JSON.stringify(parsed, null, 2));

    const collection =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;

    console.log("");
    console.log("=================================");
    console.log("COLLECTION");
    console.log("=================================");
    console.log(collection);

    if (!collection) {
      throw new Error("No ledger collection found");
    }
        if (!collection) throw new Error("No ledger collection found");

        const ledgerNames = [];

        function cleanLedgerName(name) {
          return String(name)
            .replace(/&#13;&#10;/g, ' ').replace(/&#13;/g, ' ').replace(/&#10;/g, ' ')
            .replace(/\r\n/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ')
            .replace(/\u200B/g, '').replace(/\u200C/g, '').replace(/\u200D/g, '')
            .replace(/\u00A0/g, ' ').replace(/\uFEFF/g, '')
            .replace(/\u2028/g, ' ').replace(/\u2029/g, ' ')
            .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
        }

        function extractNames(obj) {
          if (!obj) return;
          if (Array.isArray(obj)) { obj.forEach(extractNames); return; }
          if (typeof obj === "object") {
            if (obj.NAME) {
              let ledgerName = typeof obj.NAME === "object"
                ? obj.NAME?._ || null
                : String(obj.NAME).trim();
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
        console.log(`📊 Total ledgers found: ${uniqueLedgers.length}`);

        let inserted = 0, updated = 0;
        const failedLedgers = [];

        for (let i = 0; i < uniqueLedgers.length; i++) {
          const ledgerName = uniqueLedgers[i];
          const savepointName = `sp_ledger_${i}`;

          // ✅ SAVEPOINT per ledger — one failure won't kill the whole transaction
          await client.query(`SAVEPOINT ${savepointName}`);

          try {
            console.log(`[${i + 1}/${uniqueLedgers.length}] Processing: ${ledgerName}`);

            const xmlSafeName = ledgerName
              .replace(/&/g, '&amp;').replace(/</g, '&lt;')
              .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

            let guid = null;
            let gstNumber = null;

            const detailsXML = getLedgerDetailsXML(company, xmlSafeName);
            const detailsResponse = await sendToTallyViaConnector(companyId, detailsXML, "sync");

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

            if (Array.isArray(ledger)) {
      ledger = ledger[0];
    }

    if (ledger?.GUID) {

      guid = typeof ledger.GUID === "object"
        ? ledger.GUID?._ || null
        : String(ledger.GUID).trim();

      gstNumber =
        ledger?.PARTYGSTIN
          ? (
              typeof ledger.PARTYGSTIN === "object"
                ? ledger.PARTYGSTIN?._ || null
                : String(ledger.PARTYGSTIN).trim()
            )
          : null;

      if (!gstNumber) {

        console.log(
          "GST DETAILS:",
          JSON.stringify(
            ledger?.["LEDGSTREGDETAILS.LIST"],
            null,
            2
          )
        );

        gstNumber =
          ledger?.["LEDGSTREGDETAILS.LIST"]?.GSTIN ||
          ledger?.["LEDGSTREGDETAILS.LIST"]?.REGISTRATIONNUMBER ||
          ledger?.["LEDGSTREGDETAILS.LIST"]?.GSTREGISTRATIONNUMBER ||
          null;
      }
    }
            }

            if (!guid) {
              console.log(`❌ No GUID from Tally, skipping: ${ledgerName}`);
              await client.query(`RELEASE SAVEPOINT ${savepointName}`);
              failedLedgers.push({ name: ledgerName, reason: "No GUID returned from Tally" });
              continue;
            }

            // ✅ Only pass columns your table ACTUALLY has
            const result = await upsertRecord(
              "app_test.ledgers",
              guid,
              null,
              null,
              [companyId, company, ledgerName, gstNumber],
              ["company_id", "company_name", "name", "gst_number"],
              client
            );

            await client.query(`RELEASE SAVEPOINT ${savepointName}`);

            if (result.action === "inserted") { inserted++; console.log(`✅ INSERTED: ${ledgerName}`); }
            else if (result.action === "updated") { updated++; console.log(`🔄 UPDATED: ${ledgerName}`); }

          } catch (err) {
            // ✅ Roll back only THIS ledger, transaction stays alive
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);

            console.log(`❌ FAILED: ${ledgerName}`);
            console.log(`   ERROR: ${err.message}`);          // <-- this will show the REAL first error
            console.log(`   CODE:  ${err.code}`);             // e.g. 42703 = undefined_column
            console.log(`   DETAIL: ${err.detail || ''}`);

            failedLedgers.push({ name: ledgerName, reason: err.message, code: err.code });
          }
        }

        await client.query("COMMIT");

        if (failedLedgers.length > 0) {
          console.log("=== FAILED LEDGERS ===");
          failedLedgers.slice(0, 20).forEach((l, idx) => {
            console.log(`${idx + 1}. "${l.name}" | code: ${l.code} | reason: ${l.reason}`);
          });
        }

        console.log("=================================");
        console.log(`Total   : ${uniqueLedgers.length}`);
        console.log(`Inserted: ${inserted} | Updated: ${updated} | Failed: ${failedLedgers.length}`);
        console.log("=================================");

        return res.status(200).json({
          status: "success",
          company,
          summary: {
            total_found: uniqueLedgers.length,
            inserted,
            updated,
            failed: failedLedgers.length,
            // First failed ledger shown to help debug
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
      BANK ACCOUNTS SYNC (UPDATED WITH company_id & IMPROVED TALLY COMPATIBILITY)
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
      const responseXML =
      await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);

    console.log(
      "RAW TALLY XML:",
      responseXML
    );
        const parsed = await parseXML(responseXML);
        
        const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
        const list = Array.isArray(collection) ? collection : [collection];
        console.log("TOTAL TALLY RECORDS:", list.length);
        
        let inserted = 0, updated = 0, ignored = 0;
        
      for (const ledger of list) {

      const ledgerName = clean(
      ledger?.$?.NAME ||
      ledger?.["@NAME"] ||
      ledger?.NAME ||
      ledger?.MAILINGNAME ||
      ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME
    );
      if (!ledgerName) {

        console.log(
          "SKIPPED RECORD:",
          JSON.stringify(ledger, null, 2)
        );

        continue;
      }

      console.log(
        "PROCESSING:",
        ledgerName
      );
          
          const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
          const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'bank');
          const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
          const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;

        const openingBalance = cleanBalance(
      ledger?.OPENINGBALANCE
    );

    const closingBalance = cleanBalance(
      ledger?.CLOSINGBALANCE
    );

    const email = clean(
      ledger?.EMAIL ||
      ledger?.LEDGEREMAIL
    );

    const phoneNumber = clean(
      ledger?.PHONE ||
      ledger?.PHONENUMBER ||
      ledger?.LEDGERPHONE
    );

    const primaryPhoneNumber = clean(
      ledger?.MOBILE ||
      ledger?.MOBILENUMBER ||
      ledger?.LEDGERMOBILE
    );

    const gstNumber = clean(
      ledger?.PARTYGSTIN ||
      ledger?.GSTIN
    );
    const openingBalanceType =
      Number(openingBalance) < 0
        ? "Dr"
        : "Cr";

    const closingBalanceType =
      Number(closingBalance) < 0
        ? "Dr"
        : "Cr";
          
          const result = await upsertRecord(
            "app_test.bank_accounts", guid, masterId, alterId,
            [
              companyId,
              company,
              ledgerName,
              "Bank Accounts",
              clean(
      ledger?.BANKACCHOLDERNAME ||
      ledger?.ACHOLDERNAME ||
      ledger?.BankAccHolderName
    ),
              clean(
                ledger?.BANKACCOUNTNUMBER ||
                ledger?.BANKACCOUNTNO ||
                ledger?.ACCOUNTNUMBER ||
                ledger?.BANKDETAILS
              ),
              clean(
                ledger?.IFSCCODE ||
                ledger?.IFSCODE
              ),
              clean(ledger?.SWIFTCODE),

    clean(
      ledger?.BANKNAME
    ),

    clean(
      ledger?.BANKBRANCHNAME ||
      ledger?.BRANCHNAME
    ),
              Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
                ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
                : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS),
              clean(ledger?.STATENAME || ledger?.LEDSTATENAME || ledger?.STATE),
              clean(ledger?.COUNTRYNAME),
            clean(ledger?.PINCODE),

    gstNumber,

    openingBalance,
    closingBalance,
    openingBalanceType,
    closingBalanceType,

    email,

    phoneNumber,

    primaryPhoneNumber
            ],
          [
      "company_id",
      "company_name",
      "ledger_name",
      "parent_group",

      "account_holder_name",
      "account_number",

      "ifsc_code",
      "swift_code",

      "bank_name",
      "branch",

      "address",
      "state",
      "country",
      "pincode",

      "gst_number",

      "opening_balance",
      "closing_balance",

      "opening_balance_type",
      "closing_balance_type",

      "email",
      "phone_number",
      "primary_phone_number"
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
      VOUCHER SYNC (FIXED - PROPER TRANSACTION HANDLING)
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
          GET COMPANY ID (OUTSIDE TRANSACTION)
        ===================================== */
        const companyId = await getCompanyId(company, client);
        if (!companyId) {
          throw new Error("Company not found");
        }
        
        /* =====================================
          BUILD XML & FETCH FROM TALLY
        ===================================== */
        const xml = getLedgerVouchersXML(company, fromDate, toDate);
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
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
          PROCESS EACH VOUCHER IN SEPARATE TRANSACTION
          (To prevent one failure from breaking everything)
        ===================================== */
        for (const voucher of list) {
          try {
            const voucherNumber = clean(voucher?.VOUCHERNUMBER);
            if (!voucherNumber) {
              failed++;
              continue;
            }

            /* =================================
              LEDGER ENTRIES
            ================================= */
            const entries = voucher?.["ALLLEDGERENTRIES.LIST"];
            const normalized = Array.isArray(entries) ? entries : entries ? [entries] : [];
            

              /* ================================
              BASIC VALUES
            ================================= */
            const originalGuid = voucher?.GUID || null;
            const voucherDate = clean(voucher?.DATE)?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
            const voucherTypeName = clean(voucher?.VOUCHERTYPENAME);
            const partyLedgerName = clean(voucher?.PARTYLEDGERNAME);

            /* =================================
              AMOUNTS
            ================================= */
        let debitAmount = 0;
    let creditAmount = 0;

    const partyEntry = normalized.find(
      entry =>
        clean(entry?.LEDGERNAME) === partyLedgerName
    );

    if (partyEntry) {

      const amount = Number(
        partyEntry?.AMOUNT || 0
      );

      if (amount < 0) {
        debitAmount = Math.abs(amount);
      } else {
        creditAmount = amount;
      }

    }

            const balance = debitAmount - creditAmount;

    console.log("VOUCHER DEBUG");
    console.log({
      voucherNumber,
      debitAmount,
      creditAmount,
      balance
    });

        
            /* ================================
              FILTERS
            ================================= */
            if (voucherType && !voucherTypeName?.toLowerCase().includes(voucherType.toLowerCase())) {
              ignored++;
              continue;
            }
            if (party && !partyLedgerName?.toLowerCase().includes(party.toLowerCase())) {
              ignored++;
              continue;
            }

      /* ================================
      START A NEW TRANSACTION FOR THIS VOUCHER
    ================================ */

    /* ================================
      START TRANSACTION
    ================================ */

    const voucherClient =
      await pool.connect();

    try {

      await voucherClient.query(
        "BEGIN"
      );

      /* ================================
        INSERT VOUCHER
      ================================ */

      const guid =

        originalGuid ||

        generateFallbackGuid(

          company,

          `${voucherDate}_${voucherTypeName}_${voucherNumber}`,

          "voucher"

        );

      const masterId =
        voucher?.MASTERID || null;

      const alterId =
        voucher?.ALTERID || 0;

      const upsertResult = await voucherClient.query(

        `
        INSERT INTO app_test.vouchers (

          guid,
          master_id,
          alter_id,
          company_id,
          company_name,
          voucher_date,
          voucher_type,
          voucher_number,
          party_ledger_name,
          narration,
          ledger_entries,
          debit_amount,
          credit_amount,
          balance,
          created_at,
          updated_at

        )

        VALUES (

          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          NOW(), NOW()

        )
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

          guid,
          masterId,
          alterId,
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

        balance

        ]

      );

      if (upsertResult.rows[0]?.was_inserted) {
        inserted++;
      } else {
        updated++;
      }

      /* ================================
        INSERT SALES ITEMS
      ================================ */

      for (const entry of normalized) {

        const inventoryAllocations =
          entry?.["INVENTORYALLOCATIONS.LIST"];

        const allocations =

          Array.isArray(
            inventoryAllocations
          )

            ? inventoryAllocations

            : inventoryAllocations

            ? [inventoryAllocations]

            : [];

        if (allocations.length === 0) {

          continue;

        }

        for (const item of allocations) {

          if (!item?.STOCKITEMNAME) {

            continue;

          }

          await voucherClient.query(

            `
            INSERT INTO app_test.sales_items (

              company_id,
              company_name,
              voucher_number,
              description,
              actual_quantity,
              billed_quantity,
              total_amount,
              created_at,
              updated_at

            )

            VALUES (

              $1, $2, $3, $4,
              $5, $6, $7,
              NOW(),
              NOW()

            )
            `,

            [

              companyId,

              company,

              voucherNumber,

              item?.STOCKITEMNAME || null,

              parseFloat(
                String(
                  item?.ACTUALQTY || 0
                ).replace(/[^\d.-]/g, "")
              ),

              parseFloat(
                String(
                  item?.BILLEDQTY || 0
                ).replace(/[^\d.-]/g, "")
              ),

              Math.abs(creditAmount)

            ]

          );

        }

      }

      /* ================================
        COMMIT
      ================================ */

      await voucherClient.query(
        "COMMIT"
      );

    } catch (voucherError) {

      await voucherClient.query(
        "ROLLBACK"
      );

      failed++;

      console.log(
        `❌ Voucher ${voucherNumber} failed:`,
        voucherError.message
      );

      await createAuditLog({

        action:
          "VOUCHER_SYNC_RECORD_FAILED",

        entity:
          "voucher-sync",

        metadata: {

          company,

          error:
            voucherError.message,

          voucher:
            voucherNumber

        },

        logType:
          "ERROR"

      });

    } finally {

      voucherClient.release();

    }

    

          } catch (loopError) {
            failed++;
            console.log(`❌ Voucher ${voucher?.VOUCHERNUMBER} failed:`, loopError.message);
            
            await createAuditLog({
              action: "VOUCHER_SYNC_RECORD_FAILED",
              entity: "voucher-sync",
              metadata: { company, error: loopError.message, voucher: voucher?.VOUCHERNUMBER },
              logType: "ERROR"
            });
          }
        }

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
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
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
      return res.status(400).json({ status: "error", message: "company query parameter required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const companyId = await getCompanyId(company, client);
      if (!companyId) throw new Error("Company not found");

      const getGroupData = async (groupName) => {
        const xml = getGroupBalanceXML(company, groupName);
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
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

      const debtors   = await getGroupData("Sundry Debtors");
      const creditors = await getGroupData("Sundry Creditors");

      // ── NEW: fetch Stock-in-Hand the same way ──────────────────────
      let stock = await getGroupData("Stock-in-Hand");

      // Tally sometimes stores this group as "Stock-in-Hand" and sometimes
      // as "Stock in Hand" (see getStockInHandXML's OR-filter for the same
      // reason). If the first name comes back empty, retry the alt spelling
      // before giving up — same defensive pattern as elsewhere in this file.
      if (!stock.group_name || (!stock.opening_balance && !stock.closing_balance && !stock.guid)) {
        stock = await getGroupData("Stock in Hand");
      }
      // ─────────────────────────────────────────────────────────────

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
      await upsertGroup(stock);   // ← NEW

      await client.query("COMMIT");

      return res.status(200).json({
        status: "success",
        source: "tally",
        message: "Group balances synced successfully",
        company,
        summary: { inserted, updated, ignored, total: 3 },   // was 2, now 3
        data: { debtors, creditors, stock }                   // ← NEW
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
      PROFIT LOSS SYNC - COMPLETE FIXED VERSION
    =================================================== */

    router.get("/profit-loss-sync", async (req, res) => {
      const company = req.query.company;
      const fromDate = req.query.fromDate;
      const toDate = req.query.toDate;

      /* =========================================
        VALIDATION
      ========================================= */
      if (!company || !fromDate || !toDate) {
        return res.status(400).json({
          status: "error",
          message: "company, fromDate and toDate required"
        });
      }

      const client = await pool.connect();

      try {
        /* =====================================
          BEGIN TRANSACTION
        ===================================== */
        await client.query("BEGIN");

        /* =====================================
          GET COMPANY ID
        ===================================== */
        const companyResult = await client.query(
          `SELECT id FROM app_test.companies WHERE name = $1`,
          [company]
        );

        const companyId = companyResult.rows[0]?.id;

        if (!companyId) {
          throw new Error("Company not found");
        }

        /* =====================================
          GENERATE XML REQUEST
        ===================================== */
        const xml = getProfitLossXML(company, fromDate, toDate);

        console.log("📤 SENDING XML REQUEST TO TALLY...");

        /* =====================================
          SEND TO TALLY
        ===================================== */
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);

        console.log("📥 RAW XML RESPONSE:");
        console.log(responseXML.substring(0, 500) + "...");

        /* =====================================
          PARSE XML RESPONSE
        ===================================== */
        const parsed = await parseXML(responseXML);

        // Log full parsed structure for debugging
        console.log("🔍 PARSED STRUCTURE:");
        console.log(JSON.stringify(parsed, null, 2).substring(0, 1000));

        /* =====================================
          EXTRACT GROUPS FROM PARSED XML
        ===================================== */
        const groups =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP || [];

        const list = Array.isArray(groups) ? groups : [groups];

        console.log(`📊 FOUND ${list.length} GROUPS`);

        /* =====================================
          INITIALIZE VALUES
        ===================================== */
        let totalSales = 0;
        let totalPurchase = 0;
        let directExpenses = 0;
        let directIncomes = 0;
        let stockValue = 0;
        let indirectIncome = 0;
        let indirectExpenses = 0;

        /* =====================================
          PROCESS EACH GROUP
        ===================================== */
        for (const group of list) {
          // Extract name (handle both array and single value)
          let rawName = 
            group?.["LANGUAGENAME.LIST"]?.[0]?.["NAME.LIST"]?.[0]?.NAME ||
            group?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
            group?.NAME;

          // Convert to array for consistent handling
          let names = [];
          if (Array.isArray(rawName)) {
            names = rawName;
          } else if (rawName) {
            names = [rawName];
          }

          // Extract balance (handle both array and single value)
          let rawBalance = group?.CLOSINGBALANCE;
          
          if (Array.isArray(rawBalance)) {
            rawBalance = rawBalance[0];
          }

          const balance = Math.abs(Number(rawBalance || 0));

          console.log(`✓ GROUP: ${names.join(", ")} | BALANCE: ₹${balance.toLocaleString()}`);

          /* =================================
            CATEGORIZE BY GROUP NAME
          ================================= */
          
          // Sales Accounts
          if (names.some(n => n === "Sales Accounts" || n?.includes("Sales"))) {
            totalSales = balance;
          }
          
          // Purchase Accounts
          else if (names.some(n => n === "Purchase Accounts" || n?.includes("Purchase"))) {
            totalPurchase = balance;
          }
          
          // Direct Expenses
          else if (names.some(n => n === "Direct Expenses" || n?.includes("Direct Expenses"))) {
            directExpenses = balance;
          }
          
          // Direct Incomes
          else if (names.some(n => n === "Direct Incomes" || n?.includes("Direct Incomes"))) {
            directIncomes = balance;
          }
          
          // Stock-in-hand
          else if (names.some(n => n === "Stock-in-hand" || n?.includes("Stock-in-hand"))) {
            stockValue = balance;
          }
          
          // Indirect Incomes
          else if (names.some(n => n === "Indirect Incomes" || n?.includes("Indirect Income"))) {
            indirectIncome = balance;
          }
          
          // Indirect Expenses
          else if (names.some(n => n === "Indirect Expenses" || n?.includes("Indirect Expense"))) {
            indirectExpenses = balance;
          }
        }

        /* =====================================
          CALCULATE P&L METRICS
        ===================================== */
        
        const grossProfit = Number(
          (
            totalSales -
            totalPurchase -
            directExpenses +
            directIncomes
          ).toFixed(2)
        );

        const netProfit = Number(
          (
            grossProfit +
            indirectIncome -
            indirectExpenses
          ).toFixed(2)
        );

        const profitMargin = totalSales > 0
          ? Number(
              (
                netProfit /
                totalSales
              ) * 100
            ).toFixed(2)
          : 0;

        /* =====================================
          PREPARE DATA OBJECT
        ===================================== */
        const profitLossData = {
          totalSales,
          totalPurchase,
          directExpenses,
          directIncomes,
          stockValue,
          indirectIncome,
          indirectExpenses,
          grossProfit,
          netProfit,
          profitMargin: Number(profitMargin)
        };

        console.log("💰 CALCULATED P&L:");
        console.log(JSON.stringify(profitLossData, null, 2));

        /* =====================================
          UPSERT TO DATABASE
        ===================================== */
        const guid = `${companyId}_${fromDate}_${toDate}`;
        const alterId = 1;

        const result = await upsertRecord(
          "app_test.profit_loss",
          guid,
          null,
          alterId,
          [
            companyId,
            company,
            fromDate,
            toDate,
            totalSales,
            totalPurchase,
            stockValue,
            grossProfit,
            netProfit,
            profitMargin
          ],
          [
            "company_id",
            "company_name",
            "from_date",
            "to_date",
            "total_sales",
            "total_purchase",
            "stock_value",
            "gross_profit",
            "net_profit",
            "profit_margin"
          ],
          client
        );

        /* =====================================
          COMMIT TRANSACTION
        ===================================== */
        await client.query("COMMIT");

        /* =====================================
          SUCCESS RESPONSE
        ===================================== */
        return res.status(200).json({
          status: "success",
          source: "tally",
          message: "Profit loss synced successfully",
          company,
          fromDate,
          toDate,
          dateRange: {
            from: formatDate(fromDate),
            to: formatDate(toDate)
          },
          summary: {
            action: result.action
          },
          data: profitLossData
        });

      } catch (err) {
        /* =====================================
          ROLLBACK ON ERROR
        ===================================== */
        await client.query("ROLLBACK");

        console.error("❌ PROFIT LOSS SYNC ERROR:", err.message);
        console.error(err.stack);

        return res.status(500).json({
          status: "error",
          message: err.message,
          detail: process.env.NODE_ENV === "development" ? err.stack : undefined
        });

      } finally {
        client.release();
      }
    });

    /* ===================================================
      HELPER: FORMAT DATE FOR DISPLAY
    =================================================== */
    function formatDate(dateStr) {
      // Convert YYYYMMDD to DD-MM-YYYY
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

    router.get(
      "/stock-group-summary-sync",
      async (req, res) => {
        /* =====================================
          COMPANY
        ===================================== */
        const company = req.query.company;
        if (!company) {
          return res.status(400).json({
            status: "error",
            message: "company required"
          });
        }

        /* =====================================
          DB CLIENT
        ===================================== */
        const client = await pool.connect();

        try {
          /* =====================================
            BEGIN TRANSACTION
          ===================================== */
          await client.query("BEGIN");

          /* =====================================
            GET COMPANY ID
          ===================================== */
          const companyId = await getCompanyId(company, client);
          if (!companyId) {
            throw new Error("Company not found");
          }

          /* =====================================
            XML
          ===================================== */
          const xml = getStockGroupSummaryXML(company);

          /* =====================================
            TALLY RESPONSE
          ===================================== */
          const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
          console.log(responseXML);

          /* =====================================
            XML PARSE
          ===================================== */
          const parsed = await parseXML(responseXML);

        
          /* =====================================
            STOCK ITEMS
          ===================================== */
          const stockItems = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.STOCKITEM || [];
          const list = Array.isArray(stockItems) ? stockItems : [stockItems];

          /* =====================================
            COUNTERS
          ===================================== */
          let inserted = 0;
          let updated = 0;

          /* =====================================
            LOOP
          ===================================== */
          for (const item of list) {
            /* =================================
              ITEM NAME
            ================================= */
          let itemName =
      item?.NAME ||
      item?.["@_NAME"] ||
      item?.["$"]?.NAME ||
      item?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
      null;

    if (Array.isArray(itemName)) {
      itemName = itemName[0];
    }

    if (typeof itemName === "object" && itemName !== null) {
      itemName =
        itemName._ ||
        itemName.NAME ||
        JSON.stringify(itemName);
    }

    itemName = clean(itemName);

            /* =================================
              GROUP NAME
            ================================= */
            const groupName = (item?.PARENT || "").replace("&#4;", "").trim();

            /* =================================
              QUANTITY
            ================================= */
            const quantity = parseFloat(item?.CLOSINGBALANCE || 0) || 0;

            /* =================================
              STOCK VALUE
            ================================= */
            const rawStockValue = parseFloat(item?.CLOSINGVALUE || 0) || 0;

            /* =================================
              FIX TALLY SIGN
            ================================= */
            const stockValue = rawStockValue * -1;

            /* =================================
              HSN CODE
            ================================= */
            let hsnCode = null;
            const hsnList = item?.["HSNDETAILS.LIST"] || [];
            if (Array.isArray(hsnList)) {
              const validHSN = hsnList.find((hsn) => hsn?.HSNCODE);
              hsnCode = validHSN?.HSNCODE || null;
            } else {
              hsnCode = hsnList?.HSNCODE || null;
            }

            /* =================================
              CHECK EXISTING
            ================================= */
            const existing = await client.query(
              `
              SELECT id
              FROM app_test.stock_group_summary
              WHERE company_name = $1
              AND item_name = $2
              `,
              [company, itemName]
            );

            /* =================================
              UPDATE EXISTING
            ================================= */
            if (existing.rows.length > 0) {
              await client.query(
                `
                UPDATE app_test.stock_group_summary
                SET
                  company_id = $1,
                  group_name = $2,
                  hsn_code = $3,
                  quantity = $4,
                  stock_value = $5,
                  updated_at = NOW()
                WHERE company_name = $6
                AND item_name = $7
                `,
                [companyId, groupName, hsnCode, quantity, stockValue, company, itemName]
              );
              updated++;
              continue;
            }

            /* =================================
              INSERT NEW
            ================================= */
            await client.query(
              `
              INSERT INTO app_test.stock_group_summary (
                company_id,
                company_name,
                group_name,
                item_name,
                hsn_code,
                quantity,
                stock_value
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              `,
              [companyId, company, groupName, itemName, hsnCode, quantity, stockValue]
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
            message: "Stock group summary synced successfully",
            company,
            summary: {
              inserted,
              updated,
              total: list.length
            },
            data: list.map((item) => {
              /* =============================
                QUANTITY
              ============================= */
              const quantity = parseFloat(item?.CLOSINGBALANCE || 0) || 0;

              /* =============================
                STOCK VALUE
              ============================= */
              const rawStockValue = parseFloat(item?.CLOSINGVALUE || 0) || 0;

              /* =============================
                FIX TALLY SIGN
              ============================= */
              const stockValue = rawStockValue * -1;

              /* =============================
                DEBUG
              ============================= */
            // ✅ REPLACE with this — derive itemName inline
  const mappedName = item?.NAME ||
    item?.["@_NAME"] ||
    item?.["$"]?.NAME ||
    item?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
    null;

  console.log({
    item_name: mappedName,
    quantity,
    rawStockValue,
    finalStockValue: stockValue
  });

              /* =============================
                RETURN
              ============================= */
              return {
                group_name: (item?.PARENT || "").replace("&#4;", "").trim(),
                item_name: item?.NAME ||
                  item?.["@_NAME"] ||
                  item?.["$"]?.NAME ||
                  item?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
                  null,
                hsn_code: (() => {
                  const hsnList = item?.["HSNDETAILS.LIST"] || [];
                  if (Array.isArray(hsnList)) {
                    const validHSN = hsnList.find((hsn) => hsn?.HSNCODE);
                    return validHSN?.HSNCODE || null;
                  }
                  return hsnList?.HSNCODE || null;
                })(),
                quantity,
                stock_value: stockValue
              };
            })
          });
        } catch (err) {
          /* =====================================
            ROLLBACK
          ===================================== */
          await client.query("ROLLBACK");
          console.log("❌ STOCK GROUP SUMMARY SYNC ERROR:", err.message);
          return res.status(500).json({
            status: "error",
            message: err.message
          });
        } finally { 
          /* =====================================
            RELEASE CLIENT
          ===================================== */
          client.release();
        }
      }
    );
    /* ===================================================
      CREATE SYNC JOB
    =================================================== */

  router.post(
    "/manual",
    async (req, res) => {

      try {

        const userId = await resolveUserId(req);
        if (!userId) {
          return res.status(404).json({
            status: "error",
            message: "No profile found for this account"
          });
        }

        const {
          company,
          fromYear,
          toYear
        } = req.body;

        if (!company || !fromYear || !toYear) {
          return res.status(400).json({
            status: "error",
            message: "Company, fromYear and toYear are required"
          });
        }

        await pool.query(
          `
          INSERT INTO app_test.companies
          (
            name,
            financial_year_start,
            financial_year_end
          )
          VALUES ($1, $2, $3)

          ON CONFLICT (name)
          DO UPDATE SET
            financial_year_start = EXCLUDED.financial_year_start,
            financial_year_end = EXCLUDED.financial_year_end,
            updated_at = NOW()
          `,
          [
            company.trim(),
            fromYear,
            toYear
          ]
        );

        const payload = {
          company,
          fromYear,
          toYear
        };

        const result = await pool.query(
          `
          INSERT INTO app_test.job_logs
          (
            job_type,
            status,
            payload
          )
          VALUES
          (
            $1,
            $2,
            $3
          )

          RETURNING id
          `,
          [
            "manual_sync",
            "pending",
            payload
          ]
        );

        const jobLogId = result.rows[0].id;

        await syncQueue.add(
          "manual-sync",
          {
            jobLogId,
            company,
            fromYear,
            toYear,
            userId
          },
          {
            ...SYNC_JOB_OPTIONS,
            jobId: getSyncJobId(jobLogId)
          }
        );

        return res.status(200).json({
          status: "success",
          message: "Sync job created successfully",
          data: {
            jobId: jobLogId,
            company,
            status: "pending"
          }
        });

      } catch (err) {

        console.log(err.message);

        return res.status(500).json({
          status: "error",
          message: err.message
        });

      }

    }
  );


    /* ===================================================
    DASHBOARD SYNC (AUTO)
  =================================================== */

  router.post(
    "/manual-auto",
    async (req, res) => {

      try {

        const userId = await resolveUserId(req);

        if (!userId) {
          return res.status(401).json({
            status: "error",
            message: "Unauthenticated"
          });
        }

        /* =====================================
          FIND THIS USER'S SYNCED COMPANY
          Joins through connector_pairing_tokens since
          app_test.companies has no user_id column —
          the pairing token is the only reliable link
          between a user and the company they've synced.
        ===================================== */

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
          WHERE cpt.user_id = $1
            AND cpt.is_used = TRUE
            AND c.financial_year_start IS NOT NULL
            AND c.financial_year_end IS NOT NULL
          ORDER BY cpt.created_at DESC
          LIMIT 1
          `,
          [userId]
        );

        if (!companyResult.rows.length) {
          return res.status(400).json({
            status: "error",
            message: "No synced company found for this user."
          });
        }

        const {
          id: syncCompanyId,
          name: company_name,
          financial_year_start: from_year,
          financial_year_end: to_year
        } = companyResult.rows[0];

        /* =====================================
          CREATE JOB
        ===================================== */

        const payload = {
          company: company_name,
          fromYear: from_year,
          toYear: to_year
        };

        const result = await pool.query(
          `
          INSERT INTO app_test.job_logs
          (
              job_type,
              status,
              payload
          )
          VALUES
          (
              $1,
              $2,
              $3
          )
          RETURNING id
          `,
          [
            "manual_sync",
            "pending",
            payload
          ]
        );

        const jobLogId = result.rows[0].id;

        /* =====================================
          ADD TO BULLMQ
        ===================================== */

        await syncQueue.add(
          "manual-sync",
          {
            jobLogId,
            company: company_name,
            fromYear: from_year,
            toYear: to_year,
            userId
          },
          {
            ...SYNC_JOB_OPTIONS,
            jobId: getSyncJobId(jobLogId)
          }
        );

        return res.status(200).json({

          status: "success",

          message: "Dashboard sync started successfully.",

          data: {

            jobId: jobLogId,

            company: company_name,

            fromYear: from_year,

            toYear: to_year,

            status: "pending"

          }

        });

      } catch (err) {

        console.log(err);

        return res.status(500).json({

          status: "error",

          message: err.message

        });

      }

    }
  );
    /* ===================================================
      UNITS SYNC
    =================================================== */

    router.get(

      "/units-sync",

      async (req, res) => {

        const company =
          req.query.company;

        if (!company) {

          return res.status(400).json({

            status: "error",

            message:
              "company query parameter required"

          });

        }

        const client =
          await pool.connect();

        try {

          await client.query(
            "BEGIN"
          );

          /* =====================================
            COMPANY ID
          ===================================== */

          const companyId =
            await getCompanyId(
              company,
              client
            );

          if (!companyId) {

            throw new Error(
              "Company not found"
            );

          }

          /* =====================================
            FETCH UNITS FROM TALLY
          ===================================== */

          const xml =
            getUnitsXML(
              company
            );

          const responseXML =
            await sendToTallyViaConnector(
              companyId,
              xml,
              "sync"
            );

          const parsed =
            await parseXML(
              responseXML
            );

          const units =
            parsed?.ENVELOPE
              ?.BODY
              ?.DATA
              ?.COLLECTION
              ?.UNIT || [];

          const list =
            Array.isArray(units)
              ? units
              : [units];

          /* =====================================
            COUNTERS
          ===================================== */

          let inserted = 0;
          let updated = 0;
          let ignored = 0;

          /* =====================================
            LOOP
          ===================================== */

          for (const unit of list) {

            const unitName =
              clean(
                unit?.NAME
              );

            if (!unitName) {
              continue;
            }

            const guid =
              generateFallbackGuid(

                company,

                unitName,

                "unit"

              );

            const result =
              await upsertRecord(

                "app_test.units",

                guid,

                null,

                1,

                [

                  companyId,

                  company,

                  unitName

                ],

                [

                  "company_id",

                  "company_name",

                  "unit_name"

                ],

                client

              );

            if (
              result.action ===
              "inserted"
            ) {

              inserted++;

            } else if (

              result.action ===
              "updated"

            ) {

              updated++;

            } else {

              ignored++;

            }

          }

          /* =====================================
            COMMIT
          ===================================== */

          await client.query(
            "COMMIT"
          );

          return res.status(200).json({

            status: "success",

            source: "tally",

            message:
              "Units synced successfully",

            company,

            summary: {

              inserted,

              updated,

              ignored,

              total:
                list.length

            }

          });

        } catch (err) {

          await client.query(
            "ROLLBACK"
          );

          console.log(

            "❌ UNITS SYNC ERROR:",

            err.message

          );

          return res.status(500).json({

            status: "error",

            message:
              err.message

          });

        } finally {

          client.release();

        }

      }

    );
    router.get("/all-ledgers-sync", async (req, res) => {
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
        
        // Get company_id using helper (like working APIs)
        const companyId = await getCompanyId(company, client);
        if (!companyId) {
          throw new Error("Company not found");
        }
        
        const xml = getAllLedgersXML(company);
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
        const parsed = await parseXML(responseXML);
        
        const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];
        const list = Array.isArray(collection) ? collection : [collection];
        
        console.log("=================================");
        console.log("📊 TOTAL LEDGERS FOUND:", list.length);
        console.log("=================================");
        
        let inserted = 0, updated = 0, ignored = 0;
        const insertedLedgers = [];
        const updatedLedgers = [];
        
        for (const ledger of list) {

    let rawLedgerName =
      ledger?.$?.NAME ||
      ledger?.["@NAME"] ||
      ledger?.NAME ||
      ledger?.MAILINGNAME ||
      ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME;

    if (Array.isArray(rawLedgerName)) {
      rawLedgerName = rawLedgerName[0];
    }

    const ledgerName = clean(rawLedgerName);
    

      if (!ledgerName) {

        ignored++;

        console.log(
          "❌ SKIPPED - NO LEDGER NAME"
        );

        continue;

      }

      console.log(
        `📌 PROCESSING: ${ledgerName}`
      );

      // remaining code...

            
          // Extract GUID (like working APIs)
          const originalGuid = ledger?.GUID || ledger?.$?.GUID || null;
          const guid = originalGuid || generateFallbackGuid(company, ledgerName, 'ledger');
          const masterId = ledger?.MASTERID || ledger?.$?.MASTERID || null;
          const alterId = ledger?.ALTERID || ledger?.$?.ALTERID || null;
          
          // Extract balances (like working APIs)
        // Extract balances
    const openingBalance = cleanBalance(ledger?.OPENINGBALANCE);
    const closingBalance = cleanBalance(ledger?.CLOSINGBALANCE);

    // Extract balance type
    const openingBalanceRaw = String(
      ledger?.OPENINGBALANCE || ""
    ).trim();

    const closingBalanceRaw = String(
      ledger?.CLOSINGBALANCE || ""
    ).trim();

    const openingBalanceType =
      Number(openingBalance) < 0
        ? "Dr"
        : "Cr";

    const closingBalanceType =
      Number(closingBalance) < 0
        ? "Dr"
        : "Cr";
      console.log(
      "BALANCE CHECK:",
      ledgerName,
      openingBalance,
      openingBalanceType,
      closingBalance,
      closingBalanceType
    );


          // Extract address (like working APIs)
          const address = Array.isArray(ledger?.["ADDRESS.LIST"]?.ADDRESS)
            ? ledger["ADDRESS.LIST"].ADDRESS.map(a => clean(a)).filter(Boolean).join(", ")
            : clean(ledger?.["ADDRESS.LIST"]?.ADDRESS);
          
          // Extract contact details (like working APIs)
          const phone = clean(ledger?.PHONE || ledger?.LEDGERPHONE);
          const mobile = clean(ledger?.MOBILE || ledger?.LEDGERMOBILE);
          const email = clean(ledger?.EMAIL || ledger?.LEDGEREMAIL);
          const fax = clean(ledger?.FAX);
        const contactPerson = clean(
      ledger?.CONTACTPERSON ||
      ledger?.["CONTACTDETAILS.LIST"]?.CONTACTPERSON ||
      ledger?.["CONTACTDETAILS.LIST"]?.NAME ||
      (
        Array.isArray(ledger?.["CONTACTDETAILS.LIST"])
          ? (
              ledger["CONTACTDETAILS.LIST"][0]?.CONTACTPERSON ||
              ledger["CONTACTDETAILS.LIST"][0]?.NAME
            )
          : null
      )
    );
    console.log(
      "CONTACT CHECK:",
      ledgerName,
      contactPerson,
      JSON.stringify(
        ledger?.["CONTACTDETAILS.LIST"],
        null,
        2
      )
    );
          // Extract tax details (like working APIs)
    const gstList = ledger?.["LEDGSTREGDETAILS.LIST"];

    const gstNumber = clean(
      Array.isArray(gstList)
        ? gstList[0]?.GSTIN
        : gstList?.GSTIN
    );

    console.log(
      "GST CHECK:",
      ledgerName,
      gstNumber
    );
          const panNumber = clean(ledger?.INCOMETAXNUMBER);
          const gstRegistrationType = clean(ledger?.GSTREGISTRATIONTYPE);
          
          // Extract location details (like working APIs)
          const state = clean(ledger?.STATENAME || ledger?.STATE || ledger?.LEDSTATENAME);
          const country = clean(ledger?.COUNTRYNAME || ledger?.LEDCOUNTRYNAME);
          const pincode = clean(ledger?.PINCODE);
          const parentGroup = clean(ledger?.PARENT || ledger?.GROUPNAME);

          const data = [
      companyId,
      company,
      ledgerName,
      parentGroup,
      address,
      state,
      country,
      pincode,
      panNumber,
      gstNumber,
      gstRegistrationType,
      contactPerson,
      phone,
      mobile,
      fax,
      email,
      openingBalance,
      closingBalance,
      openingBalanceType,
      closingBalanceType
    ];
          // Prepare data array (matching column order)
    const columns = [
      "company_id",
      "company_name",
      "ledger_name",
      "parent_group",
      "address",
      "state",
      "country",
      "pincode",
      "pan_number",
      "gst_number",
      "gst_registration_type",
      "contact_name",
      "phone_number",
      "primary_phone_number",
      "fax_no",
      "email",
      "opening_balance",
      "closing_balance",
      "opening_balance_type",
      "closing_balance_type"
    ];
          
          // Use upsertRecord like working APIs
          const result = await upsertRecord(
            "app_test.all_ledger_details",
            guid,
            masterId,
            alterId,
            data,
            columns,
            client
          );
          
          if (result.action === "inserted") {
            inserted++;
            insertedLedgers.push({
              name: ledgerName,
              guid: guid,
              parent_group: parentGroup,
              gst_number: gstNumber,
              has_address: !!address,
              has_phone: !!(phone || mobile)
            });
          } else if (result.action === "updated") {
            updated++;
            updatedLedgers.push({
              name: ledgerName,
              guid: guid,
              parent_group: parentGroup
            });
          } else {
    ignored++;

    console.log("🚨 IGNORED LEDGER");
    console.log({
      ledgerName,
      guid,
      masterId,
      alterId,
      result
    });
  }
        }
        
        await client.query("COMMIT");
        
        // RESPONSE LIKE WORKING APIs WITH DETAILED DATA
        return res.status(200).json({
          status: "success",
          source: "tally",
          message: "All ledger details synced successfully",
          company: company,
          summary: {
            total_found: list.length,
            inserted: inserted,
            updated: updated,
            ignored: ignored
          },
          // Show sample of what was inserted/updated
          samples: {
            inserted: insertedLedgers.slice(0, 5),
            updated: updatedLedgers.slice(0, 5)
          },
          // Data quality summary
          data_summary: {
            with_gst: insertedLedgers.filter(l => l.gst_number).length + updatedLedgers.filter(l => l.gst_number).length,
            with_address: insertedLedgers.filter(l => l.has_address).length + updatedLedgers.filter(l => l.has_address).length,
            with_phone: insertedLedgers.filter(l => l.has_phone).length + updatedLedgers.filter(l => l.has_phone).length
          }
        });
        
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("❌ ALL LEDGERS SYNC ERROR:", err.message);
        return res.status(500).json({
          status: "error",
          message: err.message
        });
      } finally {
        client.release();
      }
    });

    /* ===================================================
      Purchase and sales Ledger
    =================================================== */
    router.get(
      "/purchase-sales-ledgers-sync",
      async (req, res) => {

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

          const companyId = await getCompanyId(company, client);

          if (!companyId) {
            throw new Error("Company not found");
          }

          const xml = getPurchaseSalesLedgersXML(company);
          const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
          const parsed = await parseXML(responseXML);
          

          const ledgers =
            parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER || [];

          const list = Array.isArray(ledgers) ? ledgers : [ledgers];

          console.log("=================================");
          console.log("📊 TOTAL PURCHASE/SALES LEDGERS:", list.length);
          console.log("=================================");

          let inserted = 0;
          let updated = 0;
          let ignored = 0;

          for (const ledger of list) {

            /* ================================
              EXTRACT LEDGER NAME
            ================================ */
            let rawName =
              ledger?.$?.NAME ||
              ledger?.["@NAME"] ||
              ledger?.NAME ||
              ledger?.["LANGUAGENAME.LIST"]?.["NAME.LIST"]?.NAME ||
              null;

            if (Array.isArray(rawName)) rawName = rawName[0];
            if (typeof rawName === "object" && rawName !== null) rawName = rawName?._ || null;

            const ledgerName = clean(rawName);

            if (!ledgerName) {
              ignored++;
              console.log("⚠️ SKIPPED — no ledger name");
              continue;
            }

            /* ================================
              EXTRACT PARENT GROUP
            ================================ */
            const parentGroup = clean(
              ledger?.PARENT || ledger?.$?.PARENT || ""
            )?.replace(/&#4;/g, "").trim() || null;

            console.log(`📌 LEDGER: "${ledgerName}" | PARENT: "${parentGroup}"`);

            /* ================================
              DETERMINE LEDGER TYPE
            ================================ */
            const normalizedParent = (parentGroup || "").toLowerCase().trim();

            let ledgerType = null;

            if (normalizedParent.includes("purchase")) {
              ledgerType = "PURCHASE";
            } else if (normalizedParent.includes("sales")) {
              ledgerType = "SALES";
            } else {
              ignored++;
              console.log(`⚠️ SKIPPED — unknown parent group: "${parentGroup}"`);
              continue;
            }

            console.log(`✅ TYPE: ${ledgerType}`);

            /* ================================
              CHECK EXISTING
            ================================ */
            const existing = await client.query(
              `
              SELECT id
              FROM app_test.company_purchase_sales_ledgers
              WHERE company_id = $1
              AND ledger_name = $2
              `,
              [companyId, ledgerName]
            );

            /* ================================
              UPDATE
            ================================ */
            if (existing.rows.length) {

              await client.query(
                `
                UPDATE app_test.company_purchase_sales_ledgers
                SET
                  parent_group = $1,
                  ledger_type  = $2,
                  updated_at   = NOW()
                WHERE id = $3
                `,
                [parentGroup, ledgerType, existing.rows[0].id]
              );

              updated++;
              console.log(`🔄 UPDATED: ${ledgerName}`);

            } else {

              /* ================================
                INSERT
              ================================ */
              await client.query(
                `
                INSERT INTO app_test.company_purchase_sales_ledgers
                (
                  company_id,
                  ledger_name,
                  parent_group,
                  ledger_type,
                  created_at,
                  updated_at
                )
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                `,
                [companyId, ledgerName, parentGroup, ledgerType]
              );

              inserted++;
              console.log(`✅ INSERTED: ${ledgerName}`);

            }
          }

          await client.query("COMMIT");

          console.log("=================================");
          console.log(`Total   : ${list.length}`);
          console.log(`Inserted: ${inserted} | Updated: ${updated} | Ignored: ${ignored}`);
          console.log("=================================");

          return res.status(200).json({
            status: "success",
            source: "tally",
            message: "Purchase/Sales ledgers synced successfully",
            company,
            summary: {
              inserted,
              updated,
              ignored,
              total: list.length
            }
          });

        } catch (err) {

          await client.query("ROLLBACK");

          console.log("❌ PURCHASE/SALES LEDGER SYNC ERROR:", err.message);

          return res.status(500).json({
            status: "error",
            message: err.message
          });

        } finally {

          client.release();

        }

      }
    );

    /* ===================================================
      GODOWN SYNC
    =================================================== */

    router.get("/godown-sync", async (req, res) => {

      const company = req.query.company;

      if (!company) {
        return res.status(400).json({
          status  : "error",
          message : "company query parameter required"
        });
      }

      const client = await pool.connect();

      try {

        await client.query("BEGIN");

        const companyId = await getCompanyId(company, client);

        if (!companyId) {
          throw new Error("Company not found");
        }

        /*
        ====================================
        STEP 1 — FETCH GODOWNS FROM TALLY
        ====================================
        */

        const xml         = getGodownsXML(company);
        const responseXML = await sendToTallyViaConnector(companyId, xml, "sync", req.headers['x-user-id'] || null);
        const parsed      = await parseXML(responseXML);

        console.log("=================================");
        console.log("PARSED GODOWN RESPONSE");
        console.log("=================================");
        console.log(JSON.stringify(parsed, null, 2));

        /*
        ====================================
        STEP 2 — EXTRACT GODOWN LIST
        ====================================
        */

        const rawGodowns = parsed?.ENVELOPE?.DSPACCNAME || [];
        const list       = Array.isArray(rawGodowns) ? rawGodowns : [rawGodowns];

        let inserted = 0;
        let updated  = 0;
        let ignored  = 0;

        /*
        ====================================
        STEP 3 — UPSERT INTO DB
        ====================================
        */

        for (const godown of list) {

          let godownName = godown?.DSPDISPNAME || null;

          if (Array.isArray(godownName)) {
            godownName = godownName[0];
          }

          godownName = clean(godownName);

          if (!godownName) {
            ignored++;
            continue;
          }

          const existing = await client.query(
            `SELECT id
            FROM app_test.godown_details
            WHERE company_id = $1
              AND LOWER(TRIM(godown_name)) = LOWER(TRIM($2))
            LIMIT 1`,
            [companyId, godownName]
          );

          if (existing.rows.length) {

            await client.query(
              `UPDATE app_test.godown_details
              SET updated_at = NOW()
              WHERE id = $1`,
              [existing.rows[0].id]
            );

            updated++;
            console.log(`✅ GODOWN UPDATED  : ${godownName}`);

          } else {

            await client.query(
              `INSERT INTO app_test.godown_details
              (company_id, company_name, godown_name, created_at, updated_at)
              VALUES ($1, $2, $3, NOW(), NOW())`,
              [companyId, company, godownName]
            );

            inserted++;
            console.log(`✅ GODOWN INSERTED : ${godownName}`);

          }

        }

        await client.query("COMMIT");

        console.log("=================================");
        console.log("GODOWN SYNC COMPLETE");
        console.log(`   Inserted : ${inserted}`);
        console.log(`   Updated  : ${updated}`);
        console.log(`   Ignored  : ${ignored}`);
        console.log(`   Total    : ${list.length}`);
        console.log("=================================");

        return res.status(200).json({
          status  : "success",
          source  : "tally",
          message : "Godowns synced successfully",
          company,
          summary : {
            inserted,
            updated,
            ignored,
            total : list.length
          }
        });

      } catch (err) {

        await client.query("ROLLBACK");

        console.log("❌ GODOWN SYNC ERROR:", err.message);

        return res.status(500).json({
          status  : "error",
          message : err.message
        });

      } finally {

        client.release();

      }

    });

  router.get("/job-status", async (req, res) => {
    try {
      const { companyId } = req.query;

      if (!companyId) {
        return res.status(400).json({
          status: "error",
          message: "companyId is required"
        });
      }

      const result = await pool.query(
        `
        SELECT
            jl.id,
            jl.job_type,
            jl.status,
            jl.created_at,
            jl.started_at,
            jl.completed_at,
            jl.error_message,
            c.id as company_id,
            c.name as company_name
        FROM app_test.job_logs jl
        JOIN app_test.companies c
          ON c.name = jl.payload->>'company'
        WHERE c.id = $1
        ORDER BY jl.id DESC
        LIMIT 1
        `,
        [companyId]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          status: "error",
          message: "No sync job found"
        });
      }

      return res.status(200).json({
        status: "success",
        data: result.rows[0]
      });

    } catch (err) {
      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  });
  /* ===================================================
    GET SYNC STATUS for connctor company  sync status
  =================================================== */

  router.get("/status/:jobId", async (req, res) => {

    try {

      const { jobId } = req.params;

      const result = await pool.query(
        `
        SELECT
          id,
          status,
          payload,
          error_message,
          started_at,
          completed_at
        FROM app_test.job_logs
        WHERE id = $1
        `,
        [jobId]
      );

      if (!result.rows.length) {

        return res.status(404).json({
          status: "error",
          message: "Job not found"
        });

      }

      const job = result.rows[0];

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
            job.status === "completed"
              ? "Synchronization completed successfully."
              : job.status === "running"
              ? "Synchronization is in progress."
              : job.status === "failed"
              ? "Synchronization failed."
              : "Synchronization is pending."

        }

      });

    } catch (err) {

      return res.status(500).json({

        status: "error",

        message: err.message

      });

    }

  });
  router.get("/company-details", async (req, res) => {
    const company = req.query.company;

    // ============================================
    // VALIDATION
    // ============================================
    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company query parameter required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // ============================================
      // 1. GET COMPANY ID
      // ============================================
      const companyId = await getCompanyId(company, client);

      if (!companyId) {
        throw new Error("Company not found");
      }

      console.log("\n============================================");
      console.log("🏢 COMPANY DETAILS SYNC");
      console.log("Company   :", company);
      console.log("Company ID:", companyId);
      console.log("============================================");


      // ============================================
      // 2. COMPANY DETAILS + GST/TAX UNIT XML
      //
      // These two Tally requests don't depend on each other — the GST XML
      // only needs `company` (already known), not the parsed company
      // response — so both connector jobs are created up front and
      // awaited concurrently instead of one full round-trip after the
      // other. sendToTallyViaConnector() blocks per call, so two
      // sequential awaits would starve the connector of more than one job
      // at a time even though it can process several in parallel.
      // ============================================
      const companyXML = getCompanyDetailsXML(company);
      const gstXML = getCompanyGSTDetailsXML(company);

      console.log("\n📤 CALL 1: COMPANY DETAILS");
      console.log("--------------------------------------------");
      console.log(companyXML);
      console.log("--------------------------------------------");

      console.log("\n📤 CALL 2: GST TAX UNIT");
      console.log("--------------------------------------------");
      console.log(gstXML);
      console.log("--------------------------------------------");


      // ============================================
      // 3. SEND BOTH XMLs TO TALLY CONCURRENTLY
      // ============================================
      const userIdHeader = req.headers["x-user-id"] || null;

      const [companyJobId, gstJobId] = await Promise.all([
        createConnectorSyncJob(companyId, companyXML, "sync", userIdHeader),
        createConnectorSyncJob(companyId, gstXML, "sync", userIdHeader)
      ]);

      const [companyResponseXML, gstResponseXML] = await Promise.all([
        waitForConnectorSyncJob(companyJobId),
        waitForConnectorSyncJob(gstJobId)
      ]);

      console.log("\n📥 COMPANY RESPONSE");
      console.log("--------------------------------------------");
      console.log(companyResponseXML);
      console.log("--------------------------------------------");

      console.log("\n📥 GST RESPONSE");
      console.log("--------------------------------------------");
      console.log(gstResponseXML);
      console.log("--------------------------------------------");


      // ============================================
      // 4. PARSE COMPANY RESPONSE
      // ============================================
      const companyParsed =
        await parseXML(companyResponseXML);

      console.log("\n📦 PARSED COMPANY RESPONSE");
      console.log(
        JSON.stringify(companyParsed, null, 2)
      );


      // ============================================
      // 5. FIND COMPANY OBJECT
      // ============================================
      const companyData =
        companyParsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.COMPANY ||
        companyParsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;

      if (!companyData) {
        throw new Error(
          "No company details found in Tally response"
        );
      }


      // ============================================
      // HELPER FOR TALLY VALUES
      // ============================================
      const readTallyValue = (value) => {
        if (
          value === undefined ||
          value === null
        ) {
          return null;
        }

        // String
        if (typeof value === "string") {
          return value.trim();
        }

        // xml2js object with "_" value
        if (
          typeof value === "object" &&
          value._ !== undefined
        ) {
          return String(value._).trim();
        }

        // Array
        if (Array.isArray(value)) {
          if (!value.length) {
            return null;
          }

          return readTallyValue(value[0]);
        }

        return null;
      };


      // ============================================
      // 6. COMPANY NAME
      // ============================================
      const name =
        readTallyValue(companyData?.NAME) ||
        company;


      // ============================================
      // 7. ADDRESS
      // ============================================
      let address = null;

      let addressList =
        companyData?.["ADDRESS.LIST"];

      if (Array.isArray(addressList)) {
        addressList = addressList[0];
      }

      const rawAddresses =
        addressList?.ADDRESS;

      if (rawAddresses) {
        const addresses = Array.isArray(rawAddresses)
          ? rawAddresses
          : [rawAddresses];

        address = addresses
          .map((item) => readTallyValue(item))
          .filter(Boolean)
          .join(", ");
      }


      // ============================================
      // 8. EMAIL
      // ============================================
      const email =
        readTallyValue(companyData?.EMAIL);


      // ============================================
      // 9. STATE
      // ============================================
      const state =
        readTallyValue(
          companyData?.STATENAME
        ) ||
        readTallyValue(
          companyData?.STATE
        );


      // ============================================
      // 10. GST ENABLED
      // ============================================
      const gstEnabled =
        String(
          readTallyValue(
            companyData?.ISGSTON
          ) || ""
        )
          .trim()
          .toLowerCase() === "yes";


      console.log("\n✅ COMPANY DATA");
      console.log({
        name,
        address,
        email,
        state,
        gstEnabled
      });


      // ============================================
      // 13. PARSE GST RESPONSE
      // (gstXML/gstResponseXML already fetched concurrently with the
      // company details request — see step 2/3 above)
      // ============================================
      const gstParsed =
        await parseXML(gstResponseXML);

      console.log("\n📦 PARSED GST RESPONSE");
      console.log(
        JSON.stringify(gstParsed, null, 2)
      );


      // ============================================
      // 14. FIND TAX UNITS
      // ============================================
      let taxUnits =
        gstParsed
          ?.ENVELOPE
          ?.BODY
          ?.DATA
          ?.COLLECTION
          ?.TAXUNIT || [];

      if (!Array.isArray(taxUnits)) {
        taxUnits = [taxUnits];
      }

      console.log("\n🏷️ TAX UNITS");
      console.log(
        JSON.stringify(taxUnits, null, 2)
      );


      // ============================================
      // 15. FIND GST TAX UNIT
      // ============================================
      const gstTaxUnit =
        taxUnits.find((unit) => {
          const attrs = unit?.$ || {};

          const taxType =
            String(
              attrs.TAXTYPE || ""
            )
              .trim()
              .toUpperCase();

          const taxRegistration =
            String(
              attrs.TAXREGISTRATION || ""
            ).trim();

          const gstNumber =
            readTallyValue(
              unit?.GSTREGNUMBER
            );

          return (
            taxType === "GST" ||
            taxRegistration !== "" ||
            gstNumber !== null
          );
        });


      console.log("\n✅ GST TAX UNIT");
      console.log(
        JSON.stringify(
          gstTaxUnit,
          null,
          2
        )
      );


      // ============================================
      // 16. GSTIN
      // ============================================
      let gstin = null;

      if (gstTaxUnit) {
        gstin =
          readTallyValue(
            gstTaxUnit?.GSTREGNUMBER
          );

        // fallback to TAXREGISTRATION attribute
        if (!gstin) {
          gstin =
            readTallyValue(
              gstTaxUnit?.$?.TAXREGISTRATION
            );
        }
      }


      // ============================================
      // 17. GST REGISTRATION DETAILS
      // ============================================
      let gstRegistrationDetails =
        gstTaxUnit?.[
          "GSTREGISTRATIONDETAILS.LIST"
        ] || null;


      // Tally may return an array
      if (
        Array.isArray(
          gstRegistrationDetails
        )
      ) {
        gstRegistrationDetails =
          gstRegistrationDetails[0];
      }


      // ============================================
      // 18. GST REGISTRATION TYPE
      // ============================================
      const registrationType =
        readTallyValue(
          gstRegistrationDetails
            ?.REGISTRATIONTYPE
        );


      // ============================================
      // 19. GST STATE
      // ============================================
      const gstState =
        readTallyValue(
          gstRegistrationDetails?.STATE
        ) ||
        state;


      // ============================================
      // 20. PLACE OF SUPPLY
      // ============================================
      const placeOfSupply =
        readTallyValue(
          gstRegistrationDetails
            ?.PLACEOFSUPPLY
        );


      // ============================================
      // 21. EFFECTIVE FROM
      // ============================================
      const effectiveFrom =
        readTallyValue(
          gstRegistrationDetails
            ?.FROMDATE
        );


      // ============================================
      // 22. GSTR1 PERIODICITY
      // ============================================
      const gstr1Periodicity =
        readTallyValue(
          gstRegistrationDetails
            ?.GSTR1PERIODICITY
        );


      // ============================================
      // 23. DEBUG FINAL DATA
      // ============================================
      console.log("\n============================================");
      console.log("✅ FINAL COMPANY DETAILS");
      console.log("Name              :", name);
      console.log("Address           :", address);
      console.log("Email             :", email);
      console.log("State             :", gstState || state);
      console.log("GST Enabled       :", gstEnabled);
      console.log("GSTIN             :", gstin);
      console.log("Registration Type :", registrationType);
      console.log("Place Of Supply   :", placeOfSupply);
      console.log("Effective From    :", effectiveFrom);
      console.log("GSTR1 Periodicity :", gstr1Periodicity);
      console.log("============================================");


      // ============================================
      // 24. SAVE TO DATABASE
      // ============================================
      await client.query(
        `
        INSERT INTO app_test.company_details
        (
          company_id,
          company_name,
          address,
          state,
          email,
          gstin,
          last_synced_at,
          created_at,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NOW(),
          NOW(),
          NOW()
        )

        ON CONFLICT (company_id)
        DO UPDATE SET

          company_name =
            EXCLUDED.company_name,

          address =
            EXCLUDED.address,

          state =
            EXCLUDED.state,

          email =
            EXCLUDED.email,

          gstin =
            EXCLUDED.gstin,

          last_synced_at =
            NOW(),

          updated_at =
            NOW()
        `,
        [
          companyId,
          name,
          address,
          gstState || state,
          email,
          gstin
        ]
      );


      // ============================================
      // 25. COMMIT
      // ============================================
      await client.query("COMMIT");


      // ============================================
      // 26. FINAL API RESPONSE
      // ============================================
      return res.status(200).json({
        status: "success",
        source: "tally",
        company,

        data: {
          name,
          address,
          email,
          state: gstState || state,
          gstEnabled,
          gstin,
          registrationType,
          placeOfSupply,
          effectiveFrom,
          gstr1Periodicity
        }
      });

    } catch (err) {

      // ============================================
      // ROLLBACK
      // ============================================
      await client.query("ROLLBACK");

      console.error(
        "\n❌ COMPANY DETAILS ERROR"
      );

      console.error(err);

      return res.status(500).json({
        status: "error",
        message: err.message
      });

    } finally {

      // ============================================
      // RELEASE DB CONNECTION
      // ============================================
      client.release();
    }
  });

  /* ===================================================
    PROFIT & LOSS SUMMARY SYNC
    GET /api/sync/profit-loss-summary-sync?company=...
    GET /api/sync/profit-loss-summary-sync?company=...&fromDate=2024-04-01&toDate=2025-03-31

    fromDate/toDate are OPTIONAL — defaults to current
    financial year (1 Apr → today) if omitted.
    Accepts either "YYYY-MM-DD" or Tally's "YYYYMMDD".
  =================================================== */

  router.get("/profit-loss-summary-sync", async (req, res) => {
    const company = req.query.company;
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company query parameter required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const companyId = await getCompanyId(company, client);
      if (!companyId) throw new Error("Company not found");

      const summary = await syncProfitLossSummary(client, {
        company,
        companyId,
        fromDate,
        toDate,
        userId: req.headers["x-user-id"] || null
      });

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
      return res.status(500).json({
        status: "error",
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  /* ===================================================
    PROFIT MARGIN (READ-ONLY, AUTO-SYNCS IF MISSING)
    GET /api/sync/profit-margin?company=...
    GET /api/sync/profit-margin?company=...&fromDate=2024-04-01&toDate=2025-03-31
  =================================================== */
  router.get("/profit-margin", async (req, res) => {
    const companyId = Number(req.query.company_id);
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "company_id query parameter required"
      });
    }

    const client = await pool.connect();

    try {
      // Fetch company name (needed only if we need to sync)
      const companyResult = await client.query(
        `
        SELECT name AS company_name
  FROM app_test.companies
  WHERE id = $1
        `,
        [companyId]
      );

      if (companyResult.rows.length === 0) {
        throw new Error("Company not found");
      }

      const company = companyResult.rows[0].company_name;

      // Try reading existing summary
      let query;
      let params;

      if (fromDate && toDate) {
        query = `
          SELECT *
          FROM app_test.profit_loss_summary
          WHERE company_id = $1
            AND from_date = $2
            AND to_date = $3
        `;
        params = [companyId, fromDate, toDate];
      } else {
        query = `
          SELECT *
          FROM app_test.profit_loss_summary
          WHERE company_id = $1
          ORDER BY updated_at DESC
          LIMIT 1
        `;
        params = [companyId];
      }

      let existing = await client.query(query, params);

      // If summary doesn't exist, sync it from Tally
      if (existing.rows.length === 0) {
        await client.query("BEGIN");

        await syncProfitLossSummary(client, {
          company,
          companyId,
          fromDate,
          toDate,
          userId: req.headers["x-user-id"] || null
        });

        await client.query("COMMIT");

        existing = await client.query(query, params);
      }

      const row = existing.rows[0];

      return res.status(200).json({
        status: "success",
        company_id: companyId,
        fromDate: row.from_date,
        toDate: row.to_date,
        netResult: Number(row.net_result),
        resultType: row.result_type,
        profitMarginPercent: Number(row.profit_margin_percent),
        lastSyncedAt: row.updated_at
      });

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.log("❌ PROFIT MARGIN ERROR:", err.message);

      return res.status(500).json({
        status: "error",
        message: err.message
      });
    } finally {
      client.release();
    }
  });
    export default router;
