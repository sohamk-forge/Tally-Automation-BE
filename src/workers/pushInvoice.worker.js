import pool from "../db/index.js";
import { generateXml } from "../services/xmlGenerator.js";
import { sendToTally } from "../services/tallyClient.js";

const BASE_URL =
  process.env.BASE_URL ||
  "http://localhost:5000";

let isProcessing = false;

// ADDED: Temporary error detection function
function isTemporaryInvoiceError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
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
    message.includes("stock item sync failed");
}

const processInvoiceJobs = async () => {

  if (isProcessing) {
    return;
  }

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
      console.log("📭 No Pending Invoices");
      return;
    }

    console.log(
      `📋 Found ${result.rows.length} Pending Invoices`
    );

    for (const row of result.rows) {

      try {

        console.log("");
        console.log("================================");
        console.log(`🚀 PROCESSING INVOICE ID ${row.id}`);
        console.log("================================");

        const invoiceData = row.raw_json;
        const company = row.company_name;
        const vendorName = invoiceData.vendor_name?.trim() || "";

        /*
        ====================================
        STEP 1
        SYNC LEDGERS
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
        STEP 2
        GET COMPANY ID
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

        /*
        ====================================
        STEP 3
        CHECK VENDOR LEDGER
        ====================================
        */

        const ledgerResult = await pool.query(
          `
          SELECT 1
          FROM app_test.all_ledger_details
          WHERE company_id = $1
          AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2))
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
            [`Ledger not found: ${vendorName}`, row.id]
          );
          console.log(`❌ Ledger Not Found : ${vendorName}`);
          continue;
        }

        console.log(`✅ Ledger Found : ${vendorName}`);

        /*
        ====================================
        STEP 4
        SYNC STOCK ITEMS
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
        STEP 5
        CHECK STOCK ITEMS
        ✅ FIX: item.name → item.item_name
        ====================================
        */

        const items = invoiceData.line_items || [];

        let stockMissing = false;
        let missingItem = "";

        for (const item of items) {

          // ✅ FIX: was item.name (always undefined), now item.item_name
          const itemName = item.item_name?.trim() || "";

          console.log(`🔍 Checking Stock : "${itemName}"`);

          const stockResult = await pool.query(
            `
            SELECT 1
            FROM app_test.stock_group_summary
            WHERE company_name = $1
            AND LOWER(TRIM(item_name)) = LOWER(TRIM($2))
            LIMIT 1
            `,
            [company, itemName]
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
        STEP 5.5
        SANITIZE LINE ITEMS BEFORE XML
        ✅ FIX: strip any rogue "ledger" field,
                force it to "Purchase" so Python
                never picks up "Catel Felds" or
                any other stale value
        ====================================
        */

        const sanitizedInvoiceData = {
          ...invoiceData,
          line_items: items.map((item) => ({
            ...item,
            item_name : item.item_name?.trim() || "",
            ledger    : "Purchase",   // ✅ FIX: force correct ledger
          })),
        };

        console.log(
          "🧹 Sanitized Line Items :",
          JSON.stringify(sanitizedInvoiceData.line_items, null, 2)
        );

        /*
        ====================================
        STEP 6
        GENERATE XML
        ====================================
        */

        const xml = await generateXml({
          company,
          ...sanitizedInvoiceData,  // ✅ use sanitized data
        });

        console.log("📤 XML Generated");

        /*
        ====================================
        STEP 7
        PUSH TO TALLY
        ====================================
        */

        const tallyResponse = await sendToTally(xml);

        console.log("📥 Tally Response Received");

        // REPLACED: Extract LINEERROR from response
        const lineErrorMatch =
          tallyResponse.match(
            /<LINEERROR>(.*?)<\/LINEERROR>/
          );

        const lineError =
  lineErrorMatch
    ? lineErrorMatch[1].trim()
    : null;

        const createdMatch =
          tallyResponse.match(
            /<CREATED>(\d+)<\/CREATED>/
          );

        const created =
          createdMatch
            ? Number(createdMatch[1])
            : 0;

        const alteredMatch =
          tallyResponse.match(
            /<ALTERED>(\d+)<\/ALTERED>/
          );

        const altered =
          alteredMatch
            ? Number(alteredMatch[1])
            : 0;

        const isSuccess =
          created === 1 ||
          altered === 1;

        if (!isSuccess) {
          const errorMessage =
            lineError ||
            "Tally push failed";

          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'failed',
              tally_response = $1,
              error_message = $2,
              updated_at = NOW()
            WHERE id = $3
            `,
            [
              tallyResponse,
              errorMessage,
              row.id
            ]
          );

          console.log(`❌ Invoice Failed (Tally Error): ${row.id} - ${errorMessage}`);
          continue;
        }

        /*
        ====================================
        STEP 8
        SUCCESS
        ====================================
        */

        await pool.query(
          `
          UPDATE app_test.invoice_extractions
          SET
            sync_status = 'completed',
            tally_response = $1,
            error_message = NULL,
            updated_at = NOW()
          WHERE id = $2
          `,
          [tallyResponse, row.id]
        );

        console.log(`✅ Invoice Success : ${row.id}`);

      } catch (err) {

        console.log(`💥 Invoice Failed : ${row.id}`);
        console.log(err.message);

        // REPLACED: Use isTemporaryInvoiceError for better error classification
        if (isTemporaryInvoiceError(err)) {
          await pool.query(
            `
            UPDATE app_test.invoice_extractions
            SET
              sync_status = 'pending',
              error_message = $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [err.message, row.id]
          );
          console.log(`🔄 Invoice Requeued (Temporary Error): ${row.id}`);
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
          console.log(`❌ Invoice Failed (Permanent Error): ${row.id}`);
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

console.log("✅ Push Invoice Worker Started");

// Run continuously with delay
const runContinuously = async () => {
  while (true) {
    await processInvoiceJobs();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
};

runContinuously().catch(console.error);