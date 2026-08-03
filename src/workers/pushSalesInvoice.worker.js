console.log("🚀 pushSalesInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { SALES_QUEUE_NAME } from "../queues/sales.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { generateSalesXml } from "../services/xmlGenerator.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function isTemporarySalesError(error) {
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
    message.includes("no active connector") ||
    message.includes("tally server unavailable") ||
    message.includes("server unavailable") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up")
  );
}

async function ledgerExists(companyId, ledgerName) {
  if (!ledgerName) return false;

  const found = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.all_ledger_details
    WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2))
    UNION
    SELECT 1
    FROM ${DB_SCHEMA}.push_ledger
    WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2)) AND status = 'success'
    LIMIT 1
    `,
    [companyId, ledgerName]
  );

  return found.rows.length > 0;
}

async function stockItemExists(companyId, stockItemName) {
  if (!stockItemName) return false;

  const found = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.stock_group_summary
    WHERE company_id = $1 AND LOWER(TRIM(item_name)) = LOWER(TRIM($2))
    UNION
    SELECT 1
    FROM ${DB_SCHEMA}.push_stock_item
    WHERE company_id = $1 AND LOWER(TRIM(item_name)) = LOWER(TRIM($2)) AND status = 'success'
    LIMIT 1
    `,
    [companyId, stockItemName]
  );

  return found.rows.length > 0;
}

/**
 * Validates every ledger and stock item referenced on the invoice against
 * synced master data — collecting ALL failures rather than stopping at
 * the first one, so the user gets one complete report instead of
 * fixing issues one at a time across repeated push attempts.
 */
async function validateSalesInvoice(invoice, mapping, companyId) {
  const missingLedgers = [];
  const missingStockItems = [];

  // STAGE 1: mapped ledgers (sales, CGST, SGST, IGST, rounding)
  const ledgersToValidate = [
    { field: "sales_ledger", value: mapping.sales_ledger },
    { field: "cgst_ledger", value: mapping.cgst_ledger },
    { field: "sgst_ledger", value: mapping.sgst_ledger },
    { field: "igst_ledger", value: mapping.igst_ledger },
    { field: "rounded_off_ledger", value: mapping.rounded_off_ledger }
  ].filter((entry) => entry.value); // skip unset/optional ledgers (e.g. IGST for intra-state)
  // Note: mapping now comes from company_sales_ledger_mappings, which
  // actually has a sales_ledger column — this check will now run for real
  // instead of always being skipped due to an undefined value.

  for (const { field, value } of ledgersToValidate) {
    const exists = await ledgerExists(companyId, value);
    if (!exists) {
      missingLedgers.push({ field, ledger: value });
    }
  }

  // STAGE 2: customer/party ledger
  const partyLedgerName = invoice.party_ledger || invoice.customer_name;
  if (partyLedgerName) {
    const exists = await ledgerExists(companyId, partyLedgerName);
    if (!exists) {
      missingLedgers.push({ field: "party_ledger", ledger: partyLedgerName });
    }
  }

  // STAGE 3: stock items on every line item
  // Fixed: invoice JSON uses "line_items" with "item_name", not "items"/"stock_name"/"name" —
  // the previous version silently never matched anything, so validation
  // always passed even when stock items were genuinely missing.
  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  for (const item of lineItems) {
    const stockName = (item.item_name || item.stock_name || item.name || "").trim();
    if (!stockName) continue;

    const exists = await stockItemExists(companyId, stockName);
    if (!exists && !missingStockItems.includes(stockName)) {
      missingStockItems.push(stockName);
    }
  }

  return {
    valid: missingLedgers.length === 0 && missingStockItems.length === 0,
    missingLedgers,
    missingStockItems
  };
}

function formatValidationError(validation) {
  const parts = [];

  // Missing Ledgers
  if (validation.missingLedgers.length > 0) {
    const ledgerNames = [
      ...new Set(
        validation.missingLedgers
          .map((item) => String(item.ledger || "").trim())
          .filter(Boolean)
      )
    ];

    if (ledgerNames.length > 0) {
      parts.push(`Ledger not present: ${ledgerNames.join(", ")}`);
    }
  }

  // Missing Stock Items
  if (validation.missingStockItems.length > 0) {
    const stockNames = [
      ...new Set(
        validation.missingStockItems
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    ];

    if (stockNames.length > 0) {
      parts.push(`Stock item not present: ${stockNames.join(", ")}`);
    }
  }

  return parts.length > 0
    ? parts.join(" | ")
    : "Invoice failed master data validation";
}

const worker = new Worker(
  SALES_QUEUE_NAME,
  async (job) => {
    const { salesId, userId } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for sales invoice job ${salesId}`);
    }

    console.log("Processing sales invoice", {
      salesId,
      userId
    });

    const result = await pool.query(
      `SELECT * FROM ${DB_SCHEMA}.sales_invoice_extractions WHERE id = $1`,
      [salesId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Sales invoice ${salesId} not found`);
    }

    const logCtx = {
      salesId,
      invoiceNo: row.invoice_no,
      companyId: row.company_id
    };

    const existingJobResult = await pool.query(
      `
      SELECT id, status
      FROM ${DB_SCHEMA}.connector_jobs
      WHERE job_type = 'sales_invoice'
        AND payload->>'invoice_id' = $1
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [String(salesId)]
    );

    if (existingJobResult.rows.length > 0) {
      const existingJob = existingJobResult.rows[0];
      console.log("⚠️ Skipping — connector job already in flight", {
        ...logCtx,
        connectorJobId: existingJob.id,
        connectorJobStatus: existingJob.status
      });

      return {
        salesId,
        status: "skipped_duplicate",
        connectorJobId: existingJob.id
      };
    }

    await pool.query(
      `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [salesId]
    );

    try {
      // Fixed: sales_ledger / sales_parent_group live in a SEPARATE table,
      // company_sales_ledger_mappings — not company_ledger_mappings (which
      // only has cgst/sgst/igst/tds/cess/rounded_off/purchase_ledger, no
      // sales_ledger column at all). Querying the wrong table meant
      // mapping.sales_ledger was always undefined, and something downstream
      // was silently falling back to a hardcoded "Sales" literal — which
      // doesn't exist in Tally, hence the rejection.
      const mappingResult = await pool.query(
        `SELECT * FROM ${DB_SCHEMA}.company_sales_ledger_mappings WHERE company_id = $1`,
        [row.company_id]
      );

      const mapping = mappingResult.rows[0];
      if (!mapping) {
        throw new Error(`Sales ledger mapping not configured for company ${row.company_id}`);
      }

      console.log("📋 Sales ledger mapping loaded", {
        ...logCtx,
        sales_ledger: mapping.sales_ledger,
        sales_parent_group: mapping.sales_parent_group,
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger
      });

      const invoice = typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

      // Debug visibility — confirms exactly what's being validated against,
      // so a mismatch (wrong column, wrong field name) is obvious in logs
      // rather than showing up only as a silent pass-through to Tally.
      console.log("🔍 Validation inputs", {
        ...logCtx,
        salesLedger: mapping.sales_ledger,
        cgstLedger: mapping.cgst_ledger,
        sgstLedger: mapping.sgst_ledger,
        igstLedger: mapping.igst_ledger,
        roundedOffLedger: mapping.rounded_off_ledger,
        customerLedger: invoice.party_ledger || invoice.customer_name,
        lineItemCount: Array.isArray(invoice.line_items) ? invoice.line_items.length : 0,
        lineItemNames: (invoice.line_items || []).map((i) => i.item_name || i.stock_name || i.name)
      });

      const validation = await validateSalesInvoice(invoice, mapping, row.company_id);

      if (!validation.valid) {
        const message = formatValidationError(validation);

        console.error("❌ Sales invoice failed master data validation", {
          ...logCtx,
          missingLedgers: validation.missingLedgers,
          missingStockItems: validation.missingStockItems
        });

        // Fold the structured detail into error_message itself as JSON
        // text, rather than a separate validation_result column — that
        // column doesn't exist on this table, so writing to it directly
        // would fail. No schema change needed this way.
        await pool.query(
          `
          UPDATE ${DB_SCHEMA}.sales_invoice_extractions
          SET
            sync_status = 'failed',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            JSON.stringify({
              message,
              validation_stage: validation.missingLedgers.length
                ? "ledger_validation"
                : "stock_validation",
              missing_ledgers: validation.missingLedgers,
              missing_stock_items: validation.missingStockItems
            }),
            salesId
          ]
        );

        return { salesId, status: "failed", error: message };
      }

      const xml = await generateSalesXml({
        ...invoice,
        company: row.company_name,
        sales_ledger: mapping.sales_ledger,
        sales_parent_group: mapping.sales_parent_group,
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger,
        reference_date: row.invoice_date,
        reference_number: row.invoice_no,
        voucher_type: "Sales Invoice"
      });

      console.log("📤 Sales invoice XML generated", logCtx);

      const connectorResult = await pool.query(
        `
        SELECT user_id
        FROM ${DB_SCHEMA}.connector_api_keys
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND last_seen_at >= NOW() - INTERVAL '30 seconds'
        ORDER BY last_seen_at DESC
        LIMIT 1
        `,
        [userId]
      );

      const connector = connectorResult.rows[0];
      if (!connector) {
        throw new Error(`No active connector found for user ${userId}`);
      }

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: "sales_invoice",
        requestXml: xml,
        payload: {
          invoice_id: salesId,
          company_id: row.company_id,
          invoice_no: row.invoice_no,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [salesId]
      );

      console.log("✅ Sales invoice job created for connector", {
        ...logCtx,
        connectorJobId: connectorJob.id,
        userId: connector.user_id
      });

      return {
        salesId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error("❌ Sales invoice failed", { ...logCtx, error: error.message });

      if (isTemporarySalesError(error)) {
        await pool.query(
          `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, salesId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
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
  console.log("✅ Sales invoice job completed", { jobId: job.id, result: job.returnvalue });
});

worker.on("failed", async (job, error) => {
  console.error("❌ Sales invoice job failed", { jobId: job?.id, error: error.message });

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { salesId } = job.data;
    await pool.query(
      `UPDATE ${DB_SCHEMA}.sales_invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, salesId]
    );
    console.error("Sales invoice final failure recorded", { salesId });
  } catch (updateError) {
    console.error("Sales invoice final failure update failed", { jobId: job.id, error: updateError.message });
  }
});

worker.on("error", (error) => {
  console.error("❌ Sales invoice worker error", { error: error.message });
});

console.log("✅ Push Sales Invoice BullMQ worker started (using Connector)");

export default worker;