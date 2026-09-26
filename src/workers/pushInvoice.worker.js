console.log("🚀 pushInvoice.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { PURCHASE_QUEUE_NAME, safeEnqueuePurchase } from "../queues/purchase.queue.js";
import { createConnectorJob } from "../services/connectorJob.service.js";
import { resolveConnectorForCompany, getConnectorOfflineMessage } from "../services/connectorOwner.service.js";
import { generateXmlViaQueue } from "../queues/xmlGeneration.queue.js";
import { findBestItemMatch } from "../utils/fuzzyItemMatch.js";
import { resolveMappedLedger } from "../services/vendorLedgerMapping.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// Mirrors pushSalesInvoice.worker.js's ledgerExists/stockItemExists exactly
// — same UNION-with-successfully-pushed-rows source, same whitespace
// normalization, same fuzzy fallback. Purchase never had this validation
// stage before; the sales side already proved the pattern out.
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

// Returns { exists, matchedName } — a fuzzy-matched item needs its real
// name handed back so the caller can correct the invoice before the XML
// is generated, not just report "fine" while the wrong name ships.
async function stockItemExists(companyId, stockItemName) {
  if (!stockItemName) return { exists: false, matchedName: null };

  const found = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.stock_group_summary
    WHERE company_id = $1 AND regexp_replace(LOWER(TRIM(item_name)), '\\s+', ' ', 'g') = regexp_replace(LOWER(TRIM($2)), '\\s+', ' ', 'g')
    UNION
    SELECT 1
    FROM ${DB_SCHEMA}.push_stock_item
    WHERE company_id = $1 AND regexp_replace(LOWER(TRIM(item_name)), '\\s+', ' ', 'g') = regexp_replace(LOWER(TRIM($2)), '\\s+', ' ', 'g') AND status = 'success'
    LIMIT 1
    `,
    [companyId, stockItemName]
  );

  if (found.rows.length > 0) return { exists: true, matchedName: null };

  const allNames = await pool.query(
    `
    SELECT item_name FROM ${DB_SCHEMA}.stock_group_summary WHERE company_id = $1
    UNION
    SELECT item_name FROM ${DB_SCHEMA}.push_stock_item WHERE company_id = $1 AND status = 'success'
    `,
    [companyId]
  );

  const matchedName = findBestItemMatch(allNames.rows.map((r) => r.item_name), stockItemName);
  return { exists: Boolean(matchedName), matchedName: matchedName || null };
}

// Party ledger = the vendor's saved mapping (vendor_ledger_mappings), else
// an exact ledger-name match. No guessing: a vendor whose Tally ledger has
// a different name stops at "Ledger Missing" until someone maps it once.
async function partyLedgerExists(companyId, vendorName) {
  if (!vendorName) return { exists: false, matchedName: null };

  const mappedLedger = await resolveMappedLedger(companyId, vendorName);
  if (mappedLedger) return { exists: true, matchedName: mappedLedger };

  const normalized = vendorName.trim().toLowerCase();

  const exact = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.all_ledger_details
    WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = $2
    UNION
    SELECT 1
    FROM ${DB_SCHEMA}.push_ledger
    WHERE company_id = $1 AND LOWER(TRIM(ledger_name)) = $2 AND status = 'success'
    LIMIT 1
    `,
    [companyId, normalized]
  );
  if (exact.rows.length > 0) return { exists: true, matchedName: null };

  return { exists: false, matchedName: null };
}

// Validates ledgers + stock items for a PURCHASE invoice before XML is ever
// generated. Mutates `invoice.line_items[].item_name` in place on a fuzzy
// match (same as validateSalesInvoice) — caller must persist `invoice`
// back to raw_json when renamedItems is non-empty, or the fix only lives
// in this run's memory.
async function validatePurchaseInvoice(invoice, mapping, companyId) {
  const missingLedgers = [];
  const missingStockItems = [];
  const missingStockItemDetails = {};

  const ledgersToValidate = [
    { field: "purchase_ledger", value: invoice.purchase_ledger || mapping.purchase_ledger },
    { field: "cgst_ledger", value: mapping.cgst_ledger },
    { field: "sgst_ledger", value: mapping.sgst_ledger },
    { field: "igst_ledger", value: mapping.igst_ledger },

    ...(Number(invoice.tds_amount || 0) !== 0 ? [{ field: "tds_ledger", value: mapping.tds_ledger }] : []),
    ...(Number(invoice.cess_amount || 0) !== 0 ? [{ field: "cess_ledger", value: mapping.cess_ledger }] : []),
    ...(Number(invoice.round_off || 0) !== 0 ? [{ field: "rounded_off_ledger", value: mapping.rounded_off_ledger }] : [])
  ];

  for (const { field, value } of ledgersToValidate) {
    if (!value) {
      missingLedgers.push({ field, ledger: `(mapping missing for ${field})` });
      continue;
    }

    const exists = await ledgerExists(companyId, value);
    if (!exists) missingLedgers.push({ field, ledger: value });
  }

  const renamedItems = [];

  const partyLedgerName = invoice.vendor_name || invoice.customer_name;
  if (partyLedgerName) {
    const { exists, matchedName } = await partyLedgerExists(companyId, partyLedgerName);
    if (!exists) {
      missingLedgers.push({ field: "party_ledger", ledger: partyLedgerName });
    } else if (matchedName && matchedName !== partyLedgerName) {
      // The real ledger has a disambiguating suffix Tally added (e.g.
      // "(Sundary cr.)") — the XML's PARTYLEDGERNAME must be this exact
      // string or Tally won't resolve the ledger at all.
      invoice.vendor_name = matchedName;
      renamedItems.push({ from: partyLedgerName, to: matchedName, type: "ledger" });
    }
  }

  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items : [];

  for (const item of lineItems) {
    const stockName = (item.item_name || item.name || "").trim();
    if (!stockName) continue;

    const { exists, matchedName } = await stockItemExists(companyId, stockName);
    if (!exists) {
      if (!missingStockItems.includes(stockName)) missingStockItems.push(stockName);
      if (!missingStockItemDetails[stockName]) {
        const uom = String(item.unit || "").trim();
        if (uom) missingStockItemDetails[stockName] = { unit_of_measure: uom };
      }
    } else if (matchedName && matchedName !== stockName) {
      item.item_name = matchedName;
      renamedItems.push({ from: stockName, to: matchedName });
    }
  }

  return {
    valid: missingLedgers.length === 0 && missingStockItems.length === 0,
    missingLedgers,
    missingStockItems,
    missingStockItemDetails,
    renamedItems
  };
}

// Fallback for the voucher's party state when the invoice carries no vendor
// GSTIN (generator.py can only derive the state from a GSTIN prefix). Uses
// the vendor's own ledger details in Tally: its state, else the state code of
// the GSTIN stored on that ledger. Prefers Sundry Creditor ledgers so a
// same-named debtor ledger isn't used.
async function getPartyLedgerStateInfo(companyId, ledgerName) {
  if (!ledgerName) return { state: "", gstin: "" };

  const result = await pool.query(
    `
    SELECT state, gst_number
    FROM ${DB_SCHEMA}.all_ledger_details
    WHERE company_id = $1
      AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2))
    ORDER BY (parent_group ILIKE '%creditor%') DESC,
             (COALESCE(TRIM(state), '') <> '') DESC
    LIMIT 1
    `,
    [companyId, ledgerName]
  );

  const row = result.rows[0];
  return {
    state: String(row?.state || "").trim(),
    gstin: String(row?.gst_number || "").trim()
  };
}

function formatPurchaseValidationError(validation) {
  const parts = [];

  if (validation.missingLedgers.length > 0) {
    const names = [...new Set(validation.missingLedgers.map((l) => l.ledger))];
    parts.push(`Missing/unmapped ledger(s): ${names.join(", ")}`);
  }

  if (validation.missingStockItems.length > 0) {
    parts.push(`Missing stock item(s): ${validation.missingStockItems.join(", ")}`);
  }

  return parts.join(" | ");
}

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
    // "Python exited with code 3221225794" (0xC0000005, a Windows access
    // violation) — an intermittent native crash under concurrent
    // python.exe spawns, not a real rejection of this invoice's data.
    // Confirmed transient: the exact same payload succeeds standalone,
    // and a plain re-enqueue of a batch that hit this error resolves most
    // of it. Previously this fell through to the permanent-failure branch
    // below, marking the invoice 'failed' on the very first occurrence —
    // BullMQ's own 3-attempt exponential backoff (already configured on
    // this queue) never got a chance to smooth it out.
    message.includes("python exited with code")
  );
}

const worker = new Worker(
  PURCHASE_QUEUE_NAME,
  async (job) => {
    const { invoiceId } = job.data;

    if (!invoiceId) {
      throw new Error("invoiceId is required");
    }

    const result = await pool.query(
      `SELECT * FROM app_test.invoice_extractions WHERE id = $1`,
      [invoiceId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    // Read from the row, not job.data — startup recovery re-enqueues with
    // just { invoiceId }, no rich job payload, so the row is the source of
    // truth for who requested this push.
    const userId = row.user_id;

    if (!userId) {
      throw new Error(`Missing user_id for purchase invoice ${invoiceId}`);
    }

    console.log(`[PURCHASE-INVOICE] Processing invoice ID ${invoiceId} requested by user ${userId}`);

    // Duplicate-in-flight guard (same as pushSalesInvoice.worker.js): a
    // double click, retry or startup recovery must not hand Tally the same
    // voucher twice while a connector job for it is still pending/processing.
    const existingJobResult = await pool.query(
      `
      SELECT id, status
      FROM ${DB_SCHEMA}.connector_jobs
      WHERE job_type = 'purchase_invoice'
        AND payload->>'invoice_id' = $1
        AND payload->>'requested_by_user_id' = $2
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [String(invoiceId), String(userId)]
    );

    if (existingJobResult.rows.length > 0) {
      const existingJob = existingJobResult.rows[0];
      console.log(`⚠️ Skipping — connector job already in flight for invoice ${invoiceId}`, {
        connectorJobId: existingJob.id,
        connectorJobStatus: existingJob.status
      });
      return {
        invoiceId,
        status: "skipped_duplicate",
        connectorJobId: existingJob.id
      };
    }

    await pool.query(
      `UPDATE app_test.invoice_extractions SET sync_status = 'processing', updated_at = NOW() WHERE id = $1`,
      [invoiceId]
    );

    try {
      const mappingResult = await pool.query(
        `SELECT * FROM app_test.company_ledger_mappings WHERE company_id = $1`,
        [row.company_id]
      );

      const mapping = mappingResult.rows[0];
      if (!mapping) {
        throw new Error(`Ledger mapping not configured for company ${row.company_id}`);
      }

      console.log(`📋 Ledger mapping loaded for company ${row.company_id}:`, {
        purchase_ledger: mapping.purchase_ledger,
        invoice_parent_group: mapping.invoice_parent_group,
        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger
      });

      const invoice = typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

      const validation = await validatePurchaseInvoice(invoice, mapping, row.company_id);

      // Persist any fuzzy-match corrections regardless of whether the
      // overall invoice passed — `invoice` was already mutated in place
      // above, so this just saves it back (same reasoning as
      // pushSalesInvoice.worker.js: otherwise the fix only lives in this
      // run's memory and the stored raw_json keeps showing the original
      // wrong name on every retry).
      if (validation.renamedItems?.length) {
        console.log("✏️ Auto-corrected stock item name(s) via fuzzy match", {
          invoiceId, invoiceNo: row.invoice_no, renamed: validation.renamedItems
        });
        await pool.query(
          `UPDATE app_test.invoice_extractions SET raw_json = $1, updated_at = NOW() WHERE id = $2`,
          [invoice, invoiceId]
        );
      }

      if (!validation.valid) {
        const message = formatPurchaseValidationError(validation);
        console.warn(`⚠️ Purchase invoice failed validation: ${row.invoice_no}`, {
          missingLedgers: validation.missingLedgers,
          missingStockItems: validation.missingStockItems
        });

        // Structured JSON in error_message (no separate column for it),
        // and sync_status branched by WHAT's missing rather than always
        // 'failed' — mirrors pushSalesInvoice.worker.js exactly, since a
        // purchase review endpoint needs to aggregate these same fields
        // the same way the sales missing-summary endpoint already does.
        const syncStatus =
          validation.missingLedgers.length && validation.missingStockItems.length
            ? "ledger_and_stock_missing"
            : validation.missingLedgers.length
            ? "ledger_missing"
            : validation.missingStockItems.length
            ? "stock_missing"
            : "failed";

        await pool.query(
          `
          UPDATE app_test.invoice_extractions
          SET sync_status = $1, error_message = $2, updated_at = NOW()
          WHERE id = $3
          `,
          [
            syncStatus,
            JSON.stringify({
              message,
              missing_ledgers: validation.missingLedgers,
              missing_stock_items: validation.missingStockItems,
              missing_stock_item_details: validation.missingStockItemDetails
            }),
            invoiceId
          ]
        );

        return { invoiceId, status: "failed", error: message };
      }

      const partyName = invoice.customer_name || invoice.vendor_name || "";
      const partyGstin = invoice.gstin || invoice.vendor_gstin || "";

      // No GSTIN on the invoice → fall back to the vendor ledger's details.
      // An explicit vendor_state on the invoice still wins.
      let ledgerFallback = { state: "", gstin: "" };
      if (!partyGstin && !invoice.vendor_state) {
        ledgerFallback = await getPartyLedgerStateInfo(row.company_id, partyName);
        console.log(`🗺️ No vendor GSTIN — ledger state fallback for "${partyName}":`, ledgerFallback);
      }

      const xml = await generateXmlViaQueue("purchase", {
        ...invoice,

        ...(ledgerFallback.state ? { vendor_state: ledgerFallback.state } : {}),
        // Used by generator.py only to derive the state code when the
        // ledger has a GSTIN but no state text.
        ...(ledgerFallback.gstin ? { ledger_gstin: ledgerFallback.gstin } : {}),

        company: row.company_name,

        vendor_name: invoice.customer_name || invoice.vendor_name || "",
        vendor_gstin: invoice.gstin || invoice.vendor_gstin || "",

        purchase_ledger: invoice.purchase_ledger || mapping.purchase_ledger,

        line_items: (invoice.line_items || []).map(item => ({
          ...item,
          unit: item.unit || ""
        })),

        cgst_ledger: mapping.cgst_ledger,
        sgst_ledger: mapping.sgst_ledger,
        igst_ledger: mapping.igst_ledger,
        rounded_off_ledger: mapping.rounded_off_ledger,

        // The DB row is the source of truth for the voucher date/number,
        // not whatever raw_json happens to carry. bulkPurchase.worker.js's
        // invoiceData never included invoice_date OR invoice_no at all —
        // generator.py's main <DATE> tag was silently blank for every
        // bulk-pushed invoice, and `reference_number` below was always a
        // dead key generator.py never reads (it reads `invoice_no` and
        // `reference`, not `reference_number`) — so "Supplier Invoice No."
        // came through blank in Tally too, on every bulk-pushed voucher.
        invoice_date: row.invoice_date,
        reference_date: row.invoice_date,
        invoice_no: row.invoice_no,
        reference: row.invoice_no,
        voucher_type: "Purchase Invoice"
      });

      console.log(`📤 Purchase invoice XML generated: ${row.invoice_no}`);
      console.log(`🔍 XML:\n${xml}`);

      const connector = await resolveConnectorForCompany(
        row.company_id,
        userId
      );

      if (!connector) {
        throw new Error(
          await getConnectorOfflineMessage(
            row.company_id,
            userId,
            "Tally connector is offline — start the connector app and Tally, then retry this invoice."
          )
        );
      }

      console.log(
        `🔗 Purchase invoice connector resolved: acting=${userId}, connector=${connector.user_id}`
      );

      const connectorJob = await createConnectorJob({
        userId: connector.user_id,
        jobType: 'purchase_invoice',
        requestXml: xml,
        payload: {
          invoice_id: invoiceId,
          company_id: row.company_id,
          invoice_no: row.invoice_no,
          requested_by_user_id: userId
        }
      });

      await pool.query(
        `
        UPDATE app_test.invoice_extractions
        SET
          sync_status = 'pending',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [invoiceId]
      );

      console.log(`✅ Purchase invoice job created for connector: ${row.invoice_no}`, {
        jobId: connectorJob.id,
        actingUserId: userId,
        connectorUserId: connector.user_id
      });

      return {
        invoiceId,
        status: 'pending',
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      console.error(`❌ Purchase invoice failed: ${row.invoice_no}`, error.message);

      if (isTemporaryInvoiceError(error)) {
        await pool.query(
          `UPDATE app_test.invoice_extractions SET sync_status = 'pending', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, invoiceId]
        );
        throw error;
      }

      await pool.query(
        `UPDATE app_test.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, invoiceId]
      );

      return {
        invoiceId,
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
  console.log(`[PURCHASE-INVOICE] ✅ Job completed: ${job.id}`, job.returnvalue);
});

worker.on("failed", async (job, error) => {
  console.error(`[PURCHASE-INVOICE] ❌ Job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { invoiceId } = job.data;
    await pool.query(
      `UPDATE app_test.invoice_extractions SET sync_status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, invoiceId]
    );
    console.error(`Purchase invoice final failure recorded: ${invoiceId}`);
  } catch (updateError) {
    console.error(`Purchase invoice final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("[PURCHASE-INVOICE] ❌ Worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY

Mirrors pushBank.worker.js / pushSalesInvoice.worker.js's recovery pair —
see those for the full rationale. invoices.routes.js inserts the row and
enqueues the BullMQ job as two separate steps; if the process dies in
between, the row is left at sync_status 'pending' with no job ever created
for it, silently, forever.
====================================
*/

async function markStalePendingInvoicesAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.invoice_extractions
     SET
       sync_status = 'failed',
       error_message = 'Upload interrupted / worker restarted',
       updated_at = NOW()
     WHERE sync_status = 'pending'
       AND updated_at < NOW() - INTERVAL '5 minutes'
       -- 'pending' is also the normal "waiting for the connector" state —
       -- only rows with NO in-flight connector job are genuinely orphaned.
       AND NOT EXISTS (
         SELECT 1 FROM ${DB_SCHEMA}.connector_jobs cj
         WHERE cj.job_type = 'purchase_invoice'
           AND cj.payload->>'invoice_id' = invoice_extractions.id::text
           AND cj.status IN ('pending', 'processing')
       )
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending purchase invoices as failed`);
}

async function enqueuePendingInvoiceJobs() {
  const result = await pool.query(
    `SELECT id, user_id FROM app_test.invoice_extractions ie
     WHERE ie.sync_status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM ${DB_SCHEMA}.connector_jobs cj
         WHERE cj.job_type = 'purchase_invoice'
           AND cj.payload->>'invoice_id' = ie.id::text
           AND cj.status IN ('pending', 'processing')
       )
     ORDER BY ie.id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    if (!row.user_id) continue; // pre-migration row — no safe way to attribute it, leave for manual cleanup
    const { action } = await safeEnqueuePurchase(row.id, row.user_id);
    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending purchase invoice jobs (rest already queued/active)`);
}

(async () => {
  try {
    await markStalePendingInvoicesAsFailed();
    await enqueuePendingInvoiceJobs();
  } catch (error) {
    console.error("Purchase invoice startup recovery failed:", error.message);
  }
})();

console.log("✅ Push Purchase Invoice BullMQ worker started (using Connector)");

export default worker;