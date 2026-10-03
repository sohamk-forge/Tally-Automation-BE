console.log("🚀 bulkPurchase.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { BULK_PURCHASE_QUEUE_NAME } from "../queues/bulkPurchase.queue.js";
import { pushMatchedLinesToInvoices } from "../services/purchaseExcelPush.service.js";

// Re-exported so existing importers (bulkPurchaseUpload.routes.js) keep working.
export { pushMatchedLinesToInvoices };

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password: process.env.REDIS_PASSWORD || undefined,
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

/* =====================================================================
   HEADER-TOLERANT XLSX HELPERS — same pattern as bulkSales.worker.js
   ===================================================================== */

function getValue(row, possibleKeys) {
  const rowKeys = Object.keys(row);

  for (const key of possibleKeys) {
    const target = String(key).toLowerCase();
    if (row[target] !== undefined && String(row[target]).trim() !== "") {
      return row[target];
    }
  }

  for (const key of possibleKeys) {
    const target = String(key).toLowerCase();
    const matchedKey = rowKeys.find((k) => k.startsWith(target));
    if (matchedKey && String(row[matchedKey]).trim() !== "") {
      return row[matchedKey];
    }
  }

  return "";
}

// Normalizes an Excel serial date, a "DD/MM/YYYY" string, or an already-ISO
// string into "YYYY-MM-DD" — the Purchase Report and Spare Statement use
// different representations for the same kind of date (serial numbers vs
// "DD/MM/YYYY" text) and generator.py / the purchase_po_lines.po_date
// column both want one consistent shape.
function toIsoDate(value) {
  if (!value && value !== 0) return null;

  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }

  const str = String(value).trim();
  if (!str) return null;

  const ddmmyyyy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);

  return str;
}

// Amount/quantity columns are matched on the exact header only — no
// prefix fallback like getValue() — so a blank cell can never be filled
// from a neighbouring column whose header merely starts the same way.
function getExactValue(row, possibleKeys) {
  for (const key of possibleKeys) {
    const value = row[String(key).toLowerCase()];
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return "";
}

// Text cells carry Indian digit grouping ("1,269.56", "-7,39,849") —
// Number() alone turns those into NaN, i.e. a silent 0.
function safeNumber(value) {
  const num = Number(String(value ?? "").replace(/,/g, "").trim());
  return isNaN(num) ? 0 : num;
}

function normalizeRowKeys(row) {
  const normalized = {};
  Object.keys(row).forEach((k) => {
    normalized[String(k).trim().toLowerCase()] = row[k];
  });
  return normalized;
}

export function parsePurchaseReportWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return rawRows
    .map((raw) => {
      const row = normalizeRowKeys(raw);

      return {
        po: String(getValue(row, ["purchase order no."])).trim(),
        line: String(getValue(row, ["po line item"])).trim() || "10",
        poDate: toIsoDate(getValue(row, ["purchase date"])),
        odn: String(getValue(row, ["odn"])).trim(),
        idn: String(getValue(row, ["inbound delivery no."])).trim(),
        vendorCode: String(getValue(row, ["vendor code"])).trim(),
        vendorName: String(getValue(row, ["vendor name"])).trim(),
        material: String(getValue(row, ["material"])).trim(),
        description: String(getValue(row, ["material descirption", "material description"])).trim(),
        // PO-ordered quantity — stored for reconciliation only, never
        // pushed. See services/purchaseExcelBilling.js.
        qty: safeNumber(getExactValue(row, ["quantity"])),
        // What the vendor's invoice actually billed for this line — the
        // quantity/value that get pushed (fallback: GR Qty. / GR Amount).
        vendorInvoiceQty: safeNumber(getExactValue(row, ["vendor invoice qty.", "vendor invoice qty"])),
        vendorInvoiceNetVal: safeNumber(getExactValue(row, ["vecv invoice net val", "vecv invoice net value"])),
        grQty: safeNumber(getExactValue(row, ["gr qty.", "gr qty"])),
        grAmount: safeNumber(getExactValue(row, ["gr amount"])),
        unit: String(getValue(row, ["order unit"])).trim(),
        hsn: String(getValue(row, ["hsn code"])).trim(),
        amount: safeNumber(getExactValue(row, ["amount"])),
        taxable: safeNumber(getExactValue(row, ["total taxable amount"])),
        tax: safeNumber(getExactValue(row, ["tax amount"])),
        taxDesc: String(getValue(row, ["tax description"])).trim(),
        godown: String(getValue(row, ["storage bin", "dealer plant decsrip"])).trim(),
        invoiceNo: String(getValue(row, ["vendor invoice no."])).trim(),
        invoiceDate: toIsoDate(getValue(row, ["vendor invoice date"]))
      };
    })
    .filter((r) => r.po);
}

export function parseSpareStatementWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return rawRows
    .map((raw) => {
      const row = normalizeRowKeys(raw);

      return {
        refDocNo: String(getValue(row, ["ref. doc no.", "ref doc no."])).trim(),
        invoiceNo: String(getValue(row, ["invoice no"])).trim(),
        postingDate: toIsoDate(getValue(row, ["posting date"])),
        docType: String(getValue(row, ["doc type"])).trim(),
        // Confirmed real header: "Debit Amount" — always a whole rupee in
        // this client's exports. No longer used for matching (ODN is the
        // only matching key now), kept for the reconciliation report.
        debitAmount: safeNumber(getValue(row, ["debit amount", "debit", "amount"]))
      };
    })
    .filter((r) => r.refDocNo && r.invoiceNo);
}

/* =====================================================================
   PER-ROW UPSERT INTO purchase_po_lines
   ===================================================================== */
async function upsertPoLine(companyId, userId, batchId, month, row, resolvedInvoiceNo, resolvedInvoiceDate) {
  const matchStatus = resolvedInvoiceNo ? "matched" : "pending_dispatch";

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.purchase_po_lines (
      company_id, user_id, po_no, po_line_item, po_date,
      odn, inbound_delivery_no, vendor_code, vendor_name,
      material_code, material_description, hsn_code, quantity, gr_quantity, gr_amount, unit,
      amount, taxable_amount, tax_amount, tax_description, godown_name,
      invoice_no, invoice_date, match_status, source_batch_id, month_label,
      vendor_invoice_qty, vendor_invoice_net_val,
      created_at, updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,$21,
      $22,$23,$24,$25,$26,
      $27,$28,
      NOW(),NOW()
    )
    ON CONFLICT (company_id, po_no, po_line_item, odn) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      po_date = EXCLUDED.po_date,
      odn = EXCLUDED.odn,
      inbound_delivery_no = EXCLUDED.inbound_delivery_no,
      vendor_code = EXCLUDED.vendor_code,
      vendor_name = EXCLUDED.vendor_name,
      material_code = EXCLUDED.material_code,
      material_description = EXCLUDED.material_description,
      hsn_code = EXCLUDED.hsn_code,
      quantity = EXCLUDED.quantity,
      gr_quantity = EXCLUDED.gr_quantity,
      gr_amount = EXCLUDED.gr_amount,
      vendor_invoice_qty = EXCLUDED.vendor_invoice_qty,
      vendor_invoice_net_val = EXCLUDED.vendor_invoice_net_val,
      unit = EXCLUDED.unit,
      amount = EXCLUDED.amount,
      taxable_amount = EXCLUDED.taxable_amount,
      tax_amount = EXCLUDED.tax_amount,
      tax_description = EXCLUDED.tax_description,
      godown_name = EXCLUDED.godown_name,
      source_batch_id = EXCLUDED.source_batch_id,
      month_label = EXCLUDED.month_label,
      -- Never downgrade a row that's already been pushed to Tally just
      -- because the same PO/line reappears in a re-uploaded report.
      invoice_no = CASE
        WHEN ${DB_SCHEMA}.purchase_po_lines.match_status = 'pushed' THEN ${DB_SCHEMA}.purchase_po_lines.invoice_no
        ELSE EXCLUDED.invoice_no
      END,
      invoice_date = CASE
        WHEN ${DB_SCHEMA}.purchase_po_lines.match_status = 'pushed' THEN ${DB_SCHEMA}.purchase_po_lines.invoice_date
        ELSE EXCLUDED.invoice_date
      END,
      match_status = CASE
        WHEN ${DB_SCHEMA}.purchase_po_lines.match_status = 'pushed' THEN ${DB_SCHEMA}.purchase_po_lines.match_status
        ELSE EXCLUDED.match_status
      END,
      updated_at = NOW()
    `,
    [
      companyId, userId, row.po, row.line, row.poDate,
      row.odn || null, row.idn || null, row.vendorCode || null, row.vendorName || null,
      row.material || null, row.description || null, row.hsn || null, row.qty, row.grQty, row.grAmount, row.unit || null,
      row.amount, row.taxable, row.tax, row.taxDesc || null, row.godown || null,
      resolvedInvoiceNo || null, resolvedInvoiceDate || null, matchStatus, String(batchId), month || null,
      row.vendorInvoiceQty, row.vendorInvoiceNetVal
    ]
  );
}

/* =====================================================================
   JOB 1: parse-purchase-report
   ===================================================================== */
export async function processPurchaseReportJob(job) {
  const { companyId, userId, filePath, batchId, month } = job.data;

  if (!companyId) throw new Error(`Missing companyId for bulk purchase job ${job.id}`);
  if (!userId) throw new Error(`Missing userId for bulk purchase job ${job.id}`);

  console.log(`[BULK-PURCHASE] Parsing purchase report — job ${job.id}`, { companyId, filePath });

  const rows = parsePurchaseReportWorkbook(filePath);

  let resolvedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const invoiceNo = row.invoiceNo;
    const invoiceDate = row.invoiceDate;

    // A line is only ever tracked if PO number (guaranteed — see the
    // .filter(r => r.po) in parsePurchaseReportWorkbook), ODN, AND Vendor
    // Invoice No. are ALL present together in this same report row. No
    // partial tracking, no pending_dispatch, no later resolution via a
    // Spare Statement upload — a line missing any of the three is skipped
    // here and never revisited. It only becomes eligible again if a
    // future re-upload of the Purchase Report itself carries the invoice
    // number directly. (Previously this resolved a blank invoice number
    // via an ODN match against spare_statement_entries and tracked the
    // line as pending_dispatch either way — removed per instruction.)
    if (!row.odn || !invoiceNo) {
      skippedCount++;
      continue;
    }
    resolvedCount++;

    await upsertPoLine(companyId, userId, batchId, month, row, invoiceNo, invoiceDate);
  }

  const pushed = await pushMatchedLinesToInvoices(companyId);

  console.log(`[BULK-PURCHASE] Purchase report done — job ${job.id}`, {
    totalLines: rows.length,
    resolved: resolvedCount,
    skipped: skippedCount,
    invoicesPushed: pushed.length
  });

  return { totalLines: rows.length, resolved: resolvedCount, skipped: skippedCount, invoices: pushed };
}

/* =====================================================================
   JOB 2: reconcile-spare-statement
   ===================================================================== */
export async function processSpareStatementJob(job) {
  const { companyId, filePath, month } = job.data;

  if (!companyId) throw new Error(`Missing companyId for bulk purchase job ${job.id}`);

  console.log(`[BULK-PURCHASE] Parsing spare statement — job ${job.id}`, { companyId, filePath, month });

  const rows = parseSpareStatementWorkbook(filePath);

  for (const row of rows) {
    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.spare_statement_entries (company_id, ref_doc_no, invoice_no, posting_date, doc_type, debit_amount, month_label, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (company_id, ref_doc_no) DO UPDATE SET
        invoice_no = EXCLUDED.invoice_no,
        posting_date = EXCLUDED.posting_date,
        doc_type = EXCLUDED.doc_type,
        debit_amount = EXCLUDED.debit_amount,
        month_label = EXCLUDED.month_label
      `,
      [companyId, row.refDocNo, row.invoiceNo, row.postingDate, row.docType || null, row.debitAmount || null, month || null]
    );
  }

  // Re-check the ENTIRE pending backlog for this company — not just this
  // batch — against every statement entry now on file. This is the ONLY
  // matching key now (ODN/Inbound Delivery No. = Ref. Doc No.), never
  // grouped by PO number — a PO can span multiple ODNs/invoices. Since
  // upsertPoLine now skips any line with neither an invoice number nor an
  // ODN at ingestion (see processPurchaseReportJob), every remaining
  // pending_dispatch row here already has an ODN to match on.
  const backfillResult = await pool.query(
    `
    UPDATE ${DB_SCHEMA}.purchase_po_lines p
    SET invoice_no = s.invoice_no, invoice_date = s.posting_date, match_status = 'matched', updated_at = NOW()
    FROM ${DB_SCHEMA}.spare_statement_entries s
    WHERE p.company_id = $1
      AND s.company_id = $1
      AND p.match_status = 'pending_dispatch'
      AND s.ref_doc_no <> ''
      AND (p.odn = s.ref_doc_no OR p.inbound_delivery_no = s.ref_doc_no)
    RETURNING p.id
    `,
    [companyId]
  );

  const pushed = await pushMatchedLinesToInvoices(companyId);

  console.log(`[BULK-PURCHASE] Spare statement done — job ${job.id}`, {
    statementRows: rows.length,
    backlogMatched: backfillResult.rowCount,
    invoicesPushed: pushed.length
  });

  return {
    statementRows: rows.length,
    backlogMatched: backfillResult.rowCount,
    invoices: pushed
  };
}

/* =====================================================================
   WORKER
   ===================================================================== */
const worker = new Worker(
  BULK_PURCHASE_QUEUE_NAME,
  async (job) => {
    if (job.name === "parse-purchase-report") return processPurchaseReportJob(job);
    if (job.name === "reconcile-spare-statement") return processSpareStatementJob(job);
    throw new Error(`Unknown bulkPurchase job name: ${job.name}`);
  },
  { connection, concurrency: 2 }
);

worker.on("completed", (job) => {
  console.log(`[BULK-PURCHASE] ✅ Job completed: ${job.id} (${job.name})`, job.returnvalue);
});

worker.on("failed", (job, error) => {
  console.error(`[BULK-PURCHASE] ❌ Job failed: ${job?.id} (${job?.name})`, error.message);
});

worker.on("error", (error) => {
  console.error("[BULK-PURCHASE] ❌ Worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY

Mirrors pushInvoice.worker.js's recovery pair. A crash between the
per-row upserts and pushMatchedLinesToInvoices() would otherwise leave
'matched' rows stuck — never pending (so no future report re-resolves
them) and never pushed (so invoice_extractions never sees them).
pushMatchedLinesToInvoices() derives userId per invoice group from the
rows themselves, so this needs no job context to run.
====================================
*/
async function flushMatchedBacklogOnStartup() {
  const result = await pool.query(
    `SELECT DISTINCT company_id FROM ${DB_SCHEMA}.purchase_po_lines WHERE match_status = 'matched'`
  );

  let total = 0;
  for (const { company_id: companyId } of result.rows) {
    const pushed = await pushMatchedLinesToInvoices(companyId);
    total += pushed.length;
  }

  console.log(`[BULK-PURCHASE] Startup recovery: flushed ${total} matched invoice(s) across ${result.rows.length} compan(y/ies)`);
}

(async () => {
  try {
    await flushMatchedBacklogOnStartup();
  } catch (error) {
    console.error("Bulk purchase startup recovery failed:", error.message);
  }
})();

console.log("✅ Bulk Purchase BullMQ worker started");

export default worker;
