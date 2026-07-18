console.log("🚀 pushInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { PURCHASE_QUEUE_NAME } from "../queues/purchase.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { generateXml } from "../services/xmlGenerator.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

let isProcessing = false;

function isTemporaryInvoiceError(error) {
  const code = String(error?.code || "").toUpperCase();
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND"
    ].includes(code) ||
  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND"
    ].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("timeout") ||
    message.includes("tally server unavailable") ||
    message.includes("server unavailable") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("ledger sync failed") ||
    message.includes("stock item sync failed")
  );
    message.includes("stock item sync failed")
  );
}

const processInvoiceJobs = async () => {
  if (isProcessing) return;

  isProcessing = true;

  try {
    const result = await pool.query(`
      SELECT *
      FROM app_test.invoice_extractions
      WHERE sync_status = 'pending'
      ORDER BY id ASC
      LIMIT 5
    `);

    if (!result.rows.length) {
      return;
    }

    console.log(`📋 Found ${result.rows.length} Pending Purchase Invoices`);

    for (const row of result.rows) {
      try {
        console.log("");
        console.log("================================");
        console.log(`🚀 PROCESSING PURCHASE INVOICE ID ${row.id}`);
        console.log("================================");

        const invoiceData = row.raw_json || row;
        const company = row.company_name?.trim() || "";
        const vendorName = invoiceData.vendor_name?.trim() || "";

        /*
        ====================================
        STEP 1: SYNC LEDGERS
        ====================================
        */

        console.log("🔄 Syncing Ledgers...");

        const ledgerSyncResponse = await fetch(
          `${BASE_URL}/api/sync/all-ledgers-sync?company=${encodeURIComponent(company)}`
        );

        if (!ledgerSyncResponse.ok) {
          throw new Error("Ledger Sync Failed");
        }

        /*
        ====================================
        STEP 2: GET COMPANY ID
        ====================================
        */

        const companyResult = await pool.query(
          `
          SELECT id
          FROM app_test.companies
          WHERE TRIM(name) = TRIM($1)
          LIMIT 1
          `,
          [company]
        );
        const companyId = companyResult.rows[0]?.id;

        if (!companyId) {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'failed',
              error_message = 'Company not found',
              updated_at = NOW()
            WHERE id = $1
            `,
            [row.id]
          );

          console.log(`❌ Company Not Found : ${company}`);
          continue;
        }

        console.log(`✅ Company Found : ${company}`);

        /*
        ====================================
        STEP 3: CHECK VENDOR LEDGER
        ====================================
        */

        const ledgerResult = await pool.query(
          `
          SELECT 1
          FROM (
            SELECT LOWER(TRIM(ledger_name)) AS ledger_name
            FROM app_test.all_ledger_details
            WHERE company_id = $1
            UNION
            SELECT LOWER(TRIM(ledger_name))
            FROM app_test.push_ledger
            WHERE company_id = $1
              AND status = 'success'
          ) t
          WHERE ledger_name = LOWER(TRIM($2))
          LIMIT 1
          `,
          [companyId, vendorName]
        );

        if (!ledgerResult.rows.length) {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'ledger_missing',
              error_message = $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [`Vendor ledger not found: ${vendorName}`, row.id]
          );
          console.log(`❌ Vendor Ledger Not Found : ${vendorName}`);
          continue;
        }

        console.log(`✅ Vendor Ledger Found : ${vendorName}`);

        /*
        ====================================
        STEP 4: SYNC STOCK ITEMS
        ====================================
        */

        console.log("🔄 Syncing Stock Items...");

        const stockSyncResponse = await fetch(
          `${BASE_URL}/api/sync/stock-group-summary-sync?company=${encodeURIComponent(company)}`
        );

        if (!stockSyncResponse.ok) {
          throw new Error("Stock Item Sync Failed");
        }

        /*
        ====================================
        STEP 5: CHECK STOCK ITEMS
        ====================================
        */

        const items = invoiceData.line_items || [];

        let stockMissing = false;
        let missingItem = "";

        for (const item of items) {
          const itemName = item.item_name?.trim() || item.name?.trim() || "";

          console.log(`🔍 Checking Stock : "${itemName}"`);

          const stockResult = await pool.query(
            `
            SELECT 1
            FROM (
              SELECT LOWER(TRIM(item_name)) AS item_name
              FROM app_test.stock_group_summary
              WHERE company_id = $1
              UNION
              SELECT LOWER(TRIM(item_name))
              FROM app_test.push_stock_item
              WHERE company_id = $1
                AND status = 'success'
            ) t
            WHERE item_name = LOWER(TRIM($2))
            LIMIT 1
            `,
            [companyId, itemName]
          );

          if (!stockResult.rows.length) {
            stockMissing = true;
            missingItem = itemName;
            break;
          }
        }

        if (stockMissing) {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'stock_missing',
              error_message = $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [`Stock item not found: ${missingItem}`, row.id]
          );
          console.log(`❌ Stock Item Not Found : ${missingItem}`);
          continue;
        }

        console.log("✅ All Stock Items Found");

        /*
        ====================================
        STEP 6: GENERATE XML (stays in backend) ✅
        ====================================
        */

        const xml = await generateXml({
          company,
          ...invoiceData
        });

        console.log("📤 XML Generated");

        /*
        ====================================
        STEP 7: GET CONNECTOR PAIRING
        ====================================
        */

        const pairingResult = await pool.query(
          `
          SELECT cpt.user_id
          FROM app_test.companies c
          JOIN app_test.connector_pairing_tokens cpt ON c.id = cpt.company_id
          WHERE c.id = $1
          `,
          [companyId]
        );

        const pairing = pairingResult.rows[0];
        if (!pairing) {
          throw new Error(`No connector pairing found for company ${companyId}`);
        }

        /*
        ====================================
        STEP 8: CREATE CONNECTOR JOB (NEW FLOW) ✅
        ====================================
        */

        const connectorJob = await createConnectorJob({
          userId: pairing.user_id,
          jobType: "purchase_invoice",
          requestXml: xml,
          payload: {
            invoice_id: row.id,
            company_id: companyId,
            invoice_no: invoiceData.invoice_no || "N/A",
            vendor_name: vendorName
          }
        });

        /*
        ====================================
        STEP 9: MARK AS PENDING (waiting for connector) ✅
        ====================================
        */

        await pool.query(
          `
          UPDATE app_test.invoice_extractions
          SET
            sync_status = 'pending',
            updated_at = NOW()
          WHERE id = $1
          `,
          [row.id]
        );

        console.log(`✅ Purchase Invoice Job Created for Connector: ${row.id}`, {
          jobId: connectorJob.id,
          userId: pairing.user_id
        });

      } catch (err) {
        console.log(`💥 Purchase Invoice Failed : ${row.id}`);
        console.log(err.message);

        if (isTemporaryInvoiceError(err)) {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'pending',
              error_message = NULL,
              updated_at = NOW()
            WHERE id = $1
            `,
            [row.id]
          );
          console.log(`🔄 Purchase Invoice Requeued (Temporary Error): ${row.id}`);
        } else {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'failed',
              error_message = $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [err.message, row.id]
          );
          console.log(`❌ Purchase Invoice Failed (Permanent Error): ${row.id}`);
        }
      }
    }

  } catch (err) {
    console.log("💥 Worker Error");
    console.log(err.message);

  } finally {
    isProcessing = false;
  }
};

console.log("✅ Push Purchase Invoice Worker Started (using Connector)");

const runContinuously = async () => {
  while (true) {
    await processInvoiceJobs();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
};

runContinuously().catch(console.error);