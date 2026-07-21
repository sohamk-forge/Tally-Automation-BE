import { DB_SCHEMA } from "../config/db.js";
  import { Worker } from "bullmq";
  import { redisConnection } from "../config/redis.js";
  import { SALES_QUEUE_NAME, getSalesJobId } from "../queues/sales.queue.js";
  import pool from "../db/index.js";
  import { sendToTally } from "../services/tallyClient.js";
  import { generateSalesXml } from "../services/salesXmlGenerator.js";
  import gstService from "../services/gst.service.js";

  const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

  function isTemporarySalesError(error) {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || "").toLowerCase();

    // ONLY retry for Tally connection issues - NOT for data/validation errors
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
      message.includes("ledger sync failed");
  }

  const worker = new Worker(
    SALES_QUEUE_NAME,
    async (job) => {
    const {
    salesId
  } = job.data;

      const result = await pool.query(
        `SELECT * FROM ${DB_SCHEMA}.sales_invoice_extractions WHERE id = $1`,
        [salesId]
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error(`Sales invoice ${salesId} not found`);
      }

      try {
        console.log("");
        console.log("================================");
        console.log(`PROCESSING SALES INVOICE ID ${salesId}`);
        console.log("================================");

        const invoiceData = row.raw_json;
        console.log("Invoice Sales Ledger:", invoiceData.sales_ledger);
        const company = row.company_name;
        const customerName = invoiceData.customer_name?.trim() || "";
  /*
  ====================================
  STEP 2 — GET COMPANY ID
  ====================================
  */

  const companyResult = await pool.query(
    `SELECT id
    FROM ${DB_SCHEMA}.companies
    WHERE TRIM(name) = TRIM($1)
    LIMIT 1`,
    [company]
  );

  const companyId = companyResult.rows[0]?.id;

  if (!companyId) {
    throw new Error(`Company not found: ${company}`);
  }

        /*
        ====================================
        STEP 2.5 — FETCH SALES LEDGER MAPPING
        ====================================
        */

        const mappingResult = await pool.query(
          `SELECT * FROM ${DB_SCHEMA}.company_sales_ledger_mappings WHERE company_id = $1 LIMIT 1`,
          [companyId]
        );

        if (!mappingResult.rows.length) {
          await pool.query(
            `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
            SET sync_status = 'failed',
                error_message = 'Sales ledger mapping not configured for this company. Please save mapping first.',
                updated_at = NOW()
            WHERE id = $1`,
            [salesId]
          );
          console.log(`Sales Ledger Mapping Not Configured : ${company}`);
          return { salesId, status: "failed" };
        }
        const mapping = mappingResult.rows[0];

const salesLedger =
  invoiceData.sales_ledger || mapping.sales_ledger;

        console.log(`   Sales Ledger       : ${salesLedger}`);
        console.log(`   Sales Parent Group : ${mapping.sales_parent_group}`);
  console.log(`   Sales Ledger       : ${salesLedger}`);
        console.log(`   CGST        : ${mapping.cgst_ledger}`);
        console.log(`   SGST        : ${mapping.sgst_ledger}`);
        console.log(`   IGST        : ${mapping.igst_ledger || "N/A"}`);
        console.log(`   TDS         : ${mapping.tds_ledger || "N/A"}`);
        console.log(`   CESS        : ${mapping.cess_ledger || "N/A"}`);
        console.log(`   Round Off   : ${mapping.rounded_off_ledger}`);

        /*
        ====================================
        STEP 2.6 — VALIDATE MAPPED LEDGERS IN TALLY
        ====================================
        */

      const ledgersToValidate = [
  { field: "sales_ledger", value: salesLedger },
          { field: "cgst_ledger",         value: mapping.cgst_ledger },
          { field: "sgst_ledger",         value: mapping.sgst_ledger },
          { field: "rounded_off_ledger",  value: mapping.rounded_off_ledger },
          ...(mapping.igst_ledger ? [{ field: "igst_ledger", value: mapping.igst_ledger }] : []),
          ...(mapping.tds_ledger  ? [{ field: "tds_ledger",  value: mapping.tds_ledger  }] : []),
          ...(mapping.cess_ledger ? [{ field: "cess_ledger", value: mapping.cess_ledger }] : []),
        ];

        let mappingLedgerMissing = false;
        let missingMappingLedger = "";
        let missingMappingField  = "";

        for (const { field, value } of ledgersToValidate) {
          const checkResult = await pool.query(
            `SELECT 1 FROM ${DB_SCHEMA}.all_ledger_details
            WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2)) LIMIT 1`,
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
            `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
            SET sync_status = 'failed', error_message = $1, updated_at = NOW()
            WHERE id = $2`,
            [
              `Mapped ledger not found in Tally: "${missingMappingLedger}" (field: ${missingMappingField})`,
              salesId
            ]
          );
          console.log(`Mapped Ledger Not Found In Tally : ${missingMappingLedger} (${missingMappingField})`);
          return { salesId, status: "failed" };
        }

        console.log("All Mapped Ledgers Validated");

        /*
        ====================================
        STEP 3 — CHECK CUSTOMER LEDGER
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
  [companyId, customerName]
);

        if (!ledgerResult.rows.length) {
          console.log("Customer Ledger Not Found");

          const gstin =
            invoiceData.customer_gstin ||
            invoiceData.gstin ||
            "";

          let gstResponse = null;

          if (gstin) {
            console.log("Calling GST API...");
            gstResponse = await gstService.getTaxpayerDetails(gstin);
          }

          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.sales_invoice_extractions
            SET
              sync_status = 'failed',
              error_message = $1,
              gst_details = $2,
              updated_at = NOW()
            WHERE id = $3
            `,
            [
              `Customer ledger not found: ${customerName}`,
              gstResponse?.data || null,
              salesId
            ]
          );

          console.log("GST Details Saved");
          return { salesId, status: "failed" };
        }

        console.log(`Customer Ledger Found : ${customerName}`);

        /*
        ====================================
        STEP 4 — CHECK STOCK ITEMS (NO API CALL - DIRECT DB VALIDATION)
        ====================================
        */

        console.log("Checking Stock Items From DB...");

        const items = invoiceData.line_items || [];

        let stockMissing = false;
        let missingItem  = "";

        for (const item of items) {
          const itemName =
            item.item_name?.trim() ||
            item.name?.trim() ||
            "";
          console.log(`Checking Stock : "${itemName}"`);

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
            missingItem  = itemName;
            break;
          }
        }

        if (stockMissing) {
          const missingStock = items.find((item) => {
            const itemName =
              item.item_name?.trim() ||
              item.name?.trim() ||
              "";
            return itemName.toLowerCase() === missingItem.toLowerCase();
          });
const stockMasterResult = await pool.query(
  `
  SELECT *
  FROM ${DB_SCHEMA}.stock_group_summary
  WHERE company_id = $1
    AND LOWER(TRIM(item_name)) = LOWER(TRIM($2))
  LIMIT 1
  `,
  [companyId, missingItem]
);
const stockDetails =
  stockMasterResult.rows[0] || missingStock;
         await pool.query(
  `
  UPDATE ${DB_SCHEMA}.sales_invoice_extractions
  SET
    sync_status = 'failed',
    error_message = $1,
    stock_details = $2,
    updated_at = NOW()
  WHERE id = $3
  `,
  [
    `Stock item not found: ${missingItem}`,
    stockDetails,
    salesId
  ]
);

          console.log("Stock Details Saved");
          return { salesId, status: "failed" };
        }

        console.log("All Stock Items Found");

        /*
        ====================================
        STEP 5.25 — RESOLVE GODOWN
        ====================================
        */

        const resolvedGodownName = invoiceData.godown_name?.trim() || "";

        console.log(`Godown Name : ${resolvedGodownName}`);

        /*
        ====================================
        STEP 5.5 — INJECT LEDGER MAPPING
        ====================================
        */

        const sanitizedInvoiceData = {
          ...invoiceData,
        sales_parent_group: mapping.sales_parent_group,
          sales_ledger: salesLedger,
          cgst_ledger:         mapping.cgst_ledger,
          sgst_ledger:         mapping.sgst_ledger,
          igst_ledger:         mapping.igst_ledger || "",
          tds_ledger:          mapping.tds_ledger || "",
          cess_ledger:         mapping.cess_ledger || "",
          rounded_off_ledger:  mapping.rounded_off_ledger,
          godown_name:         resolvedGodownName,
        line_items: items.map((item) => ({
    ...item,
    item_name: item.item_name?.trim() || item.name?.trim() || "",
  ledger: salesLedger,
    godown_name: resolvedGodownName,
  })),
        };

       console.log(`   Sales Ledger       : ${salesLedger}`);
        console.log(`   Sales Parent Group : ${mapping.sales_parent_group}`);
  console.log(`   Sales Ledger       : ${invoiceData.sales_ledger}`);
        console.log(`   CGST Ledger      : ${mapping.cgst_ledger}`);
        console.log(`   SGST Ledger      : ${mapping.sgst_ledger}`);
        console.log(`   IGST Ledger      : ${mapping.igst_ledger || "N/A"}`);
        console.log(`   TDS Ledger       : ${mapping.tds_ledger || "N/A"}`);
        console.log(`   CESS Ledger      : ${mapping.cess_ledger || "N/A"}`);
        console.log(`   Round Off Ledger : ${mapping.rounded_off_ledger}`);
        console.log(`   Godown Name      : ${resolvedGodownName}`);

        /*
        ====================================
        STEP 6 — GENERATE SALES XML
        ====================================
        */

        const xml = await generateSalesXml({
          company,
          ...sanitizedInvoiceData,
        });

        console.log("Sales XML Generated");

        /*
        ====================================
        STEP 7 — PUSH TO TALLY
        ====================================
        */

        const tallyResponse = await sendToTally(xml);

        console.log("Tally Response Received");

        const lineErrorMatch = tallyResponse.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
        const lineError = lineErrorMatch ? lineErrorMatch[1].trim() : null;

        const createdMatch = tallyResponse.match(/<CREATED>(\d+)<\/CREATED>/);
        const created = createdMatch ? Number(createdMatch[1]) : 0;

        const alteredMatch = tallyResponse.match(/<ALTERED>(\d+)<\/ALTERED>/);
        const altered = alteredMatch ? Number(alteredMatch[1]) : 0;

        const isSuccess = created === 1 || altered === 1;

        if (!isSuccess) {
          const errorMessage = lineError || "Tally push failed";

          await pool.query(
            `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
            SET sync_status = 'failed', tally_response = $1, error_message = $2, updated_at = NOW()
            WHERE id = $3`,
            [tallyResponse, errorMessage, salesId]
          );

          console.log(`Sales Invoice Failed (Tally Error): ${salesId} - ${errorMessage}`);
          return { salesId, status: "failed" };
        }

        /*
        ====================================
        STEP 8 — SUCCESS
        ====================================
        */

        await pool.query(
          `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
          SET sync_status = 'completed', tally_response = $1, error_message = NULL, updated_at = NOW(), synced_at = NOW()
          WHERE id = $2`,
          [tallyResponse, salesId]
        );

        console.log(`Sales Invoice Success : ${salesId}`);
        return { salesId, status: "success" };

      } catch (error) {
        console.error(`SALES ATTEMPT FAILED: ${salesId}`, error.message);

        // ONLY retry for Tally connection issues
        if (isTemporarySalesError(error)) {
          await pool.query(
            `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
            SET sync_status = 'pending',
                error_message = NULL,
                updated_at = NOW()
            WHERE id = $1`,
            [salesId]
          );
          throw error;
        }

        // Permanent error - mark as failed
        await pool.query(
          `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
          SET sync_status = 'failed', error_message = $1, updated_at = NOW()
          WHERE id = $2`,
          [error.message, salesId]
        );

        return { salesId, status: "failed" };
      }
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on("completed", (job) => {
    console.log(`Sales job completed: ${job.id}`);
  });

  worker.on("failed", async (job, error) => {
    console.error(`Sales job failed: ${job?.id}`, error.message);

    if (!job) {
      return;
    }

    const maximumAttempts = Number(job.opts.attempts || 3);

    if (job.attemptsMade < maximumAttempts) {
      return; // BullMQ will retry
    }

    // Final failure after all retries
    try {
      const { salesId } = job.data;
      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
        SET sync_status = 'failed', error_message = $1, updated_at = NOW()
        WHERE id = $2`,
        [error.message, salesId]
      );
    } catch (updateError) {
      console.error(`Sales final failure update failed: ${job.id}`, updateError.message);
    }
  });

  worker.on("error", (error) => {
    console.error("Sales worker error:", error.message);
  });

  console.log("Push Sales Invoice BullMQ Worker Started");

  export default worker;