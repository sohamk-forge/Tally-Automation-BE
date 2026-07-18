import pool from "../db/index.js";
import { generateXml } from "../services/xmlGenerator.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { DB_SCHEMA } from "../config/db.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

let isProcessing = false;

function isTemporaryInvoiceError(error) {
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
}

const processInvoiceJobs = async () => {
  if (isProcessing) return;

  isProcessing = true;

  try {
    const result = await pool.query(`
      SELECT *
      FROM ${DB_SCHEMA}.invoice_extractions
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
          FROM ${DB_SCHEMA}.companies
          WHERE TRIM(name) = TRIM($1)
          LIMIT 1
          `,
          [company]
        );
        const companyId = companyResult.rows[0]?.id;

        if (!companyId) {
          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.invoice_extractions
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
        STEP 2.5: FETCH LEDGER MAPPING
        ====================================
        */

        const mappingResult = await pool.query(
          `
          SELECT *
          FROM ${DB_SCHEMA}.company_ledger_mappings
          WHERE company_id = $1
          LIMIT 1
          `,
          [companyId]
        );

        if (!mappingResult.rows.length) {
          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.invoice_extractions
            SET
              sync_status   = 'failed',
              error_message = 'Ledger mapping not configured for this company. Please save mapping first.',
              updated_at    = NOW()
            WHERE id = $1
            `,
            [row.id]
          );
          console.log(`❌ Ledger Mapping Not Configured : ${company}`);
          continue;
        }

        const mapping = mappingResult.rows[0];

        console.log("✅ Ledger Mapping Found");
        console.log(`   Purchase Group : ${mapping.invoice_parent_group}`);
        console.log(`   CGST           : ${mapping.cgst_ledger}`);
        console.log(`   SGST           : ${mapping.sgst_ledger}`);
        console.log(`   IGST           : ${mapping.igst_ledger || "N/A"}`);
        console.log(`   TDS            : ${mapping.tds_ledger  || "N/A"}`);
        console.log(`   CESS           : ${mapping.cess_ledger || "N/A"}`);
        console.log(`   Round Off      : ${mapping.rounded_off_ledger}`);

        /*
        ====================================
        STEP 2.6: VALIDATE ALL MAPPED LEDGERS EXIST IN TALLY
        checked against ${DB_SCHEMA}.all_ledger_details
        ====================================
        */

        const ledgersToValidate = [
          { field: "invoice_parent_group", value: mapping.invoice_parent_group },
          { field: "cgst_ledger",          value: mapping.cgst_ledger          },
          { field: "sgst_ledger",          value: mapping.sgst_ledger          },
          { field: "rounded_off_ledger",   value: mapping.rounded_off_ledger   },
          // Optional — only validate if mapped
          ...(mapping.igst_ledger ? [{ field: "igst_ledger", value: mapping.igst_ledger }] : []),
          ...(mapping.tds_ledger  ? [{ field: "tds_ledger",  value: mapping.tds_ledger  }] : []),
          ...(mapping.cess_ledger ? [{ field: "cess_ledger", value: mapping.cess_ledger }] : []),
        ];

        let mappingLedgerMissing = false;
        let missingMappingLedger = "";
        let missingMappingField  = "";

        for (const { field, value } of ledgersToValidate) {

          const checkResult = await pool.query(
            `
            SELECT 1
            FROM ${DB_SCHEMA}.all_ledger_details
            WHERE company_id = $1
            AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2))
            LIMIT 1
            `,
            [companyId, value]
          );

          if (!checkResult.rows.length) {
            mappingLedgerMissing = true;
            missingMappingLedger = value;
            missingMappingField  = field;
            break;
          }
        }

        if (mappingLedgerMissing) {
          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.invoice_extractions
            SET
              sync_status   = 'ledger_missing',
              error_message = $1,
              updated_at    = NOW()
            WHERE id = $2
            `,
            [
              `Mapped ledger not found in Tally: "${missingMappingLedger}" (field: ${missingMappingField})`,
              row.id
            ]
          );
          console.log(`❌ Mapped Ledger Not Found In Tally : ${missingMappingLedger} (${missingMappingField})`);
          continue;
        }

        console.log("✅ All Mapped Ledgers Validated");

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
            FROM ${DB_SCHEMA}.all_ledger_details
            WHERE company_id = $1
            UNION
            SELECT LOWER(TRIM(ledger_name))
            FROM ${DB_SCHEMA}.push_ledger
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
            UPDATE ${DB_SCHEMA}.invoice_extractions
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
              FROM ${DB_SCHEMA}.stock_group_summary
              WHERE company_id = $1
              UNION
              SELECT LOWER(TRIM(item_name))
              FROM ${DB_SCHEMA}.push_stock_item
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
            UPDATE ${DB_SCHEMA}.invoice_extractions
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
          FROM ${DB_SCHEMA}.companies c
          JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON c.id = cpt.company_id
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
          UPDATE ${DB_SCHEMA}.invoice_extractions
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
            UPDATE ${DB_SCHEMA}.invoice_extractions
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
            UPDATE ${DB_SCHEMA}.invoice_extractions
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
