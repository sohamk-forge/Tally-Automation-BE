console.log("🚀 pushSalesInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { SALES_QUEUE_NAME } from "../queues/sales.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { generateSalesXml } from "../services/xmlGenerator.js";
import gstService from "../services/gst.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporarySalesError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code) ||
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
    message.includes("ledger sync failed")
  );
}

const worker = new Worker(
  SALES_QUEUE_NAME,
  async (job) => {
    const { salesId } = job.data;

    console.log("");
    console.log("================================");
    console.log(`PROCESSING SALES INVOICE ID ${salesId}`);
    console.log("================================");

    // STEP 1: GET SALES INVOICE FROM DB
    const result = await pool.query(
      `SELECT * FROM app_test.sales_invoice_extractions WHERE id = $1`,
      [salesId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Sales invoice ${salesId} not found`);
    }

    // STEP 2: MARK AS PROCESSING
    await pool.query(
      `UPDATE app_test.sales_invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [salesId]
    );

    try {
      const invoiceData = row.raw_json;
      const company = row.company_name;
      const customerName = invoiceData.customer_name?.trim() || "";

      // ====================================
      // STEP 2: GET COMPANY ID
      // ====================================
      const companyResult = await pool.query(
        `SELECT id FROM app_test.companies WHERE TRIM(name) = TRIM($1) LIMIT 1`,
        [company]
      );

      const companyId = companyResult.rows[0]?.id;
      if (!companyId) {
        throw new Error(`Company not found: ${company}`);
      }

      // ====================================
      // STEP 2.5: FETCH SALES LEDGER MAPPING
      // ====================================
      const mappingResult = await pool.query(
        `SELECT * FROM app_test.company_sales_ledger_mappings WHERE company_id = $1 LIMIT 1`,
        [companyId]
      );

      if (!mappingResult.rows.length) {
        await pool.query(
          `UPDATE app_test.sales_invoice_extractions
           SET sync_status = 'failed',
               error_message = 'Sales ledger mapping not configured for this company. Please save mapping first.',
               updated_at = NOW()
           WHERE id = $1`,
          [salesId]
        );
        console.log(`Sales Ledger Mapping Not Configured: ${company}`);
        return { salesId, status: "failed" };
      }

      const mapping = mappingResult.rows[0];
      const salesLedger = invoiceData.sales_ledger || mapping.sales_ledger;

      console.log(`   Sales Ledger       : ${salesLedger}`);
      console.log(`   Sales Parent Group : ${mapping.sales_parent_group}`);
      console.log(`   CGST               : ${mapping.cgst_ledger}`);
      console.log(`   SGST               : ${mapping.sgst_ledger}`);
      console.log(`   IGST               : ${mapping.igst_ledger || "N/A"}`);
      console.log(`   TDS                : ${mapping.tds_ledger || "N/A"}`);
      console.log(`   CESS               : ${mapping.cess_ledger || "N/A"}`);
      console.log(`   Round Off          : ${mapping.rounded_off_ledger}`);

      // ====================================
      // STEP 2.6: VALIDATE MAPPED LEDGERS IN DB
      // ====================================
      const ledgersToValidate = [
        { field: "sales_ledger", value: salesLedger },
        { field: "cgst_ledger", value: mapping.cgst_ledger },
        { field: "sgst_ledger", value: mapping.sgst_ledger },
        { field: "rounded_off_ledger", value: mapping.rounded_off_ledger },
        ...(mapping.igst_ledger ? [{ field: "igst_ledger", value: mapping.igst_ledger }] : []),
        ...(mapping.tds_ledger ? [{ field: "tds_ledger", value: mapping.tds_ledger }] : []),
        ...(mapping.cess_ledger ? [{ field: "cess_ledger", value: mapping.cess_ledger }] : []),
      ];

      let mappingLedgerMissing = false;
      let missingMappingLedger = "";
      let missingMappingField = "";

      for (const { field, value } of ledgersToValidate) {
        const checkResult = await pool.query(
          `SELECT 1 FROM app_test.all_ledger_details
           WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2)) LIMIT 1`,
          [companyId, value]
        );
        if (!checkResult.rows.length) {
          mappingLedgerMissing = true;
          missingMappingLedger = value;
          missingMappingField = field;
          break;
        }
      }

      if (mappingLedgerMissing) {
        await pool.query(
          `UPDATE app_test.sales_invoice_extractions
           SET sync_status = 'ledger_missing', error_message = $1, updated_at = NOW()
           WHERE id = $2`,
          [
            `Mapped ledger not found in Tally: "${missingMappingLedger}" (field: ${missingMappingField})`,
            salesId
          ]
        );
        console.log(`Mapped Ledger Not Found: ${missingMappingLedger} (${missingMappingField})`);
        return { salesId, status: "failed" };
      }

      console.log("All Mapped Ledgers Validated ✅");

      // ====================================
      // STEP 3: CHECK CUSTOMER LEDGER IN DB
      // ====================================
      const ledgerResult = await pool.query(
        `SELECT 1 FROM (
          SELECT LOWER(TRIM(ledger_name)) AS ledger_name
          FROM app_test.all_ledger_details WHERE company_id = $1
          UNION
          SELECT LOWER(TRIM(ledger_name))
          FROM app_test.push_ledger WHERE company_id = $1 AND status = 'success'
        ) t WHERE ledger_name = LOWER(TRIM($2)) LIMIT 1`,
        [companyId, customerName]
      );

      if (!ledgerResult.rows.length) {
        console.log("Customer Ledger Not Found");

        const gstin = invoiceData.customer_gstin || invoiceData.gstin || "";
        let gstResponse = null;

        if (gstin) {
          console.log("Calling GST API...");
          gstResponse = await gstService.getTaxpayerDetails(gstin);
        }

        await pool.query(
          `UPDATE app_test.sales_invoice_extractions
           SET sync_status = 'failed', error_message = $1, gst_details = $2, updated_at = NOW()
           WHERE id = $3`,
          [`Customer ledger not found: ${customerName}`, gstResponse?.data || null, salesId]
        );

        console.log("GST Details Saved");
        return { salesId, status: "failed" };
      }

      console.log(`Customer Ledger Found: ${customerName} ✅`);

      // ====================================
      // STEP 4: CHECK STOCK ITEMS IN DB
      // ====================================
      console.log("Checking Stock Items From DB...");

      const items = invoiceData.line_items || [];
      let stockMissing = false;
      let missingItem = "";

      for (const item of items) {
        const itemName = item.item_name?.trim() || item.name?.trim() || "";
        console.log(`Checking Stock: "${itemName}"`);

        const stockResult = await pool.query(
          `SELECT 1 FROM (
            SELECT LOWER(TRIM(item_name)) AS item_name
            FROM app_test.stock_group_summary WHERE company_id = $1
            UNION
            SELECT LOWER(TRIM(item_name))
            FROM app_test.push_stock_item WHERE company_id = $1 AND status = 'success'
          ) t WHERE item_name = LOWER(TRIM($2)) LIMIT 1`,
          [companyId, itemName]
        );

        if (!stockResult.rows.length) {
          stockMissing = true;
          missingItem = itemName;
          break;
        }
      }

      if (stockMissing) {
        const missingStock = items.find((item) => {
          const itemName = item.item_name?.trim() || item.name?.trim() || "";
          return itemName.toLowerCase() === missingItem.toLowerCase();
        });

        const stockMasterResult = await pool.query(
          `SELECT * FROM app_test.stock_group_summary
           WHERE company_id = $1 AND LOWER(TRIM(item_name)) = LOWER(TRIM($2)) LIMIT 1`,
          [companyId, missingItem]
        );

        const stockDetails = stockMasterResult.rows[0] || missingStock;

        await pool.query(
          `UPDATE app_test.sales_invoice_extractions
           SET sync_status = 'failed', error_message = $1, stock_details = $2, updated_at = NOW()
           WHERE id = $3`,
          [`Stock item not found: ${missingItem}`, stockDetails, salesId]
        );

        console.log("Stock Details Saved");
        return { salesId, status: "failed" };
      }

      console.log("All Stock Items Found ✅");

      // ====================================
      // STEP 5: INJECT LEDGER MAPPING
      // ====================================
      const resolvedGodownName = invoiceData.godown_name?.trim() || "";

      const sanitizedInvoiceData = {
        ...invoiceData,
        sales_parent_group: mapping.sales_parent_group,
        sales_ledger: salesLedger,
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger || "",
        tds_ledger: mapping.tds_ledger || "",
        cess_ledger: mapping.cess_ledger || "",
        rounded_off_ledger: mapping.rounded_off_ledger,
        godown_name: resolvedGodownName,
        line_items: items.map((item) => ({
          ...item,
          item_name: item.item_name?.trim() || item.name?.trim() || "",
          ledger: salesLedger,
          godown_name: resolvedGodownName,
        })),
      };

      // ====================================
      // STEP 6: GENERATE SALES XML
      // ====================================
      const xml = await generateSalesXml({
        company,
        ...sanitizedInvoiceData,
      });

      console.log("Sales XML Generated ✅");

      // ====================================
      // STEP 7: GET CONNECTOR PAIRING ✅ FIXED!
      // ====================================
      const pairingResult = await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.connector_pairing_tokens cpt
        WHERE cpt.company_id = (
          SELECT company_id FROM app_test.sales_invoice_extractions WHERE id = $1
        )
        AND cpt.is_used = true
        ORDER BY cpt.created_at DESC
        LIMIT 1
        `,
        [salesId]
      );

      const pairing = pairingResult.rows[0];
      if (!pairing) {
        throw new Error(`No connector pairing found for sales invoice ${salesId}`);
      }

      console.log(`✅ Found connector user_id: ${pairing.user_id}`);

      // ====================================
      // STEP 8: CREATE CONNECTOR JOB ✅
      // ====================================
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: 'sales_invoice',
        requestXml: xml,
        payload: {
          invoice_id: salesId,
          company_id: row.company_id,
          invoice_no: row.invoice_no
        }
      });

      // ====================================
      // STEP 9: MARK AS PENDING
      // ====================================
      await pool.query(
        `UPDATE app_test.sales_invoice_extractions SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [salesId]
      );

      console.log(`✅ Sales invoice job created for connector: ${row.invoice_no}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      return {
        salesId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Sales invoice failed: ${row.invoice_no}`, error.message);

      if (isTemporarySalesError(error)) {
        await pool.query(
          `UPDATE app_test.sales_invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, salesId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, salesId]
      );

      return {
        salesId,
        status: "failed",
        error: error.message
      };
    }
  },
  {
    connection,
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Sales invoice job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`❌ Sales invoice job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { salesId } = job.data;
    await pool.query(
      `UPDATE app_test.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, salesId]
    );
    console.error(`Sales invoice final failure recorded: ${salesId}`);
  } catch (updateError) {
    console.error(`Sales invoice final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("❌ Sales invoice worker error:", error.message);
});

console.log("✅ Push Sales Invoice BullMQ worker started (using Connector)");

export default worker;