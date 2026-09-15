console.log("🚀 bulkPurchase.worker.js loaded");

import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { BULK_PURCHASE_QUEUE_NAME } from "../queues/bulkPurchase.queue.js";
import { safeEnqueuePurchase } from "../queues/purchase.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
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

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function roundTo2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Tally "Round Off" convention: paise <= 0.50 rounds down (subtract),
// paise > 0.50 rounds up (add) — so the invoice total pushed to Tally is
// always a whole rupee, with the difference posted to the company's
// mapped rounded_off_ledger (generator.py already builds that ledger
// entry from grand_total vs. the line/tax totals; this just makes sure
// grand_total itself is always a clean rupee figure to begin with).
function roundToNearestRupee(amount) {
  const rupees = Math.floor(amount);
  const paise = roundTo2(amount - rupees);
  return paise <= 0.5 ? rupees : rupees + 1;
}

function normalizeRowKeys(row) {
  const normalized = {};
  Object.keys(row).forEach((k) => {
    normalized[String(k).trim().toLowerCase()] = row[k];
  });
  return normalized;
}

// Total Taxable Amount / Tax Amount / Amount on a purchase_po_lines row
// sometimes repeat the full PO-level total on every partial-delivery row
// instead of being split per delivery (confirmed on real data). GR Amount
// is already correctly split per delivery in the source sheet, so use it
// as the source of truth for this row's taxable amount and scale tax/
// amount by the same factor to stay internally consistent. Fall back to
// the sheet totals as-is when GR Amount is a data gap (0/null on an
// otherwise-eligible row, same gap already handled for gr_quantity).
// Shared by the push path (pushMatchedLinesToInvoices) and the
// reconciliation amount-mismatch check, so both agree on "the real
// billed amount" for a given row.
export function computeBilledAmount(row) {
  const sheetTaxable = Number(row.taxable_amount || 0);
  const grAmount = Number(row.gr_amount) || 0;
  const factor = grAmount > 0 && sheetTaxable > 0 ? grAmount / sheetTaxable : 1;
  const billedTaxable = grAmount > 0 ? grAmount : sheetTaxable;
  const billedTax = Number(row.tax_amount || 0) * factor;
  const billedAmount = Number(row.amount || 0) * factor;
  return { billedTaxable, billedTax, billedAmount };
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
        qty: safeNumber(getValue(row, ["quantity"])),
        // What this specific delivery actually billed — distinct from qty
        // (the full PO-ordered amount) once a PO is fulfilled across
        // multiple partial deliveries. See pushMatchedLinesToInvoices().
        grQty: safeNumber(getValue(row, ["gr qty."])),
        // The correctly-split per-delivery amount — Total Taxable Amount
        // sometimes repeats the full PO-level total on every partial
        // delivery row instead of being split. See pushMatchedLinesToInvoices().
        grAmount: safeNumber(getValue(row, ["gr amount"])),
        unit: String(getValue(row, ["order unit"])).trim(),
        hsn: String(getValue(row, ["hsn code"])).trim(),
        amount: safeNumber(getValue(row, ["amount"])),
        taxable: safeNumber(getValue(row, ["total taxable amount"])),
        tax: safeNumber(getValue(row, ["tax amount"])),
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
   TAX SPLIT — the Purchase Report states the tax type per line, so this
   is a lookup, not a GSTIN/state derivation like the sales worker needs.
   ===================================================================== */
function isIgst(taxDescription) {
  return /igst/i.test(taxDescription || "");
}

// Purchase Report's own "Tax Description" already states the rate per
// line, e.g. "IGST Input 18%" or "CGST & SGST Input 18%" — parsed out so
// each line item carries its own gst_rate, the same field NewItemModal's
// "Create Item in Tally" autofill (Tally-Automation-FE) reads to pre-fill
// GST Rate Details. Without this the modal had nothing to autofill from.
function parseGstRatePercent(taxDescription) {
  const match = String(taxDescription || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

// Fallback for lines where Tax Description didn't carry a literal "%"
// (blank, or a code like "V1" with no rate in the text) — back the rate
// out of the line's own taxable/tax amounts instead of leaving it null,
// same purpose as parseGstRatePercent above.
function deriveGstRateFromAmounts(taxableAmount, taxAmount) {
  const taxable = Number(taxableAmount || 0);
  const tax = Number(taxAmount || 0);
  if (taxable <= 0 || tax <= 0) return null;
  return roundTo2((tax / taxable) * 100);
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
      created_at, updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,$21,
      $22,$23,$24,$25,$26,
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
      resolvedInvoiceNo || null, resolvedInvoiceDate || null, matchStatus, String(batchId), month || null
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
   SHARED: group every 'matched' purchase_po_lines row by invoice_no,
   upsert into invoice_extractions, hand off to the existing push
   pipeline, mark 'pushed'. Self-contained (derives userId per group from
   the rows themselves) so it can also run as startup recovery with no
   job context at all.
   ===================================================================== */
async function pushMatchedLinesToInvoices(companyId) {
  const linesResult = await pool.query(
    `
    SELECT * FROM ${DB_SCHEMA}.purchase_po_lines
    WHERE company_id = $1 AND match_status = 'matched'
    ORDER BY invoice_no, po_no, po_line_item
    `,
    [companyId]
  );

  if (!linesResult.rows.length) return [];

  const companyResult = await pool.query(`SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`, [companyId]);
  const companyName = companyResult.rows[0]?.name || "";

  const gstinResult = await pool.query(
    `SELECT vendor_code, gstin FROM ${DB_SCHEMA}.vendor_gstin_mappings WHERE company_id = $1`,
    [companyId]
  );
  const gstinByVendorCode = {};
  gstinResult.rows.forEach((r) => { gstinByVendorCode[r.vendor_code] = r.gstin; });

  const byInvoice = {};
  linesResult.rows.forEach((line) => {
    (byInvoice[line.invoice_no] = byInvoice[line.invoice_no] || []).push(line);
  });

  const pushedInvoices = [];

  for (const [invoiceNo, lines] of Object.entries(byInvoice)) {
    const first = lines[0];
    const userId = first.user_id;

    if (!userId) {
      console.warn(`[BULK-PURCHASE] Skipping invoice ${invoiceNo} for company ${companyId} — no user_id on file`);
      continue;
    }

    const billedLines = lines.map((l) => ({ l, ...computeBilledAmount(l) }));

    const grandTotal = billedLines.reduce((sum, b) => sum + b.billedAmount, 0);
    const taxableTotal = billedLines.reduce((sum, b) => sum + b.billedTaxable, 0);
    const taxTotal = billedLines.reduce((sum, b) => sum + b.billedTax, 0);
    const igstLine = isIgst(first.tax_description);

    // Round the invoice total to a whole rupee before it ever reaches
    // Tally — the paise difference gets posted to the company's mapped
    // Round Off ledger (generator.py already builds that XML entry).
    const rawGrandTotal = roundTo2(grandTotal);
    const roundedGrandTotal = roundToNearestRupee(rawGrandTotal);
    const roundOff = roundTo2(roundedGrandTotal - rawGrandTotal);

    const poNumbers = [...new Set(lines.map((l) => l.po_no))];
    // A voucher can span several PO lines, each with its own ODN (SAP
    // assigns one ODN per delivery, not per invoice) — collect every
    // distinct one, same pattern as poNumbers above.
    const odnNumbers = [...new Set(lines.map((l) => l.odn).filter(Boolean))];
    const vendorGstin = gstinByVendorCode[first.vendor_code] || "";

    const lineItems = billedLines.map(({ l, billedTaxable, billedTax }) => {
      // l.quantity is the full PO-ordered amount — wrong to push as-is once
      // a PO is fulfilled across multiple partial deliveries (each ODN its
      // own delivery), since every partial delivery would then show the
      // FULL PO quantity instead of what was actually billed on that one
      // invoice. gr_quantity is the real per-delivery quantity; fall back
      // to quantity only when gr_quantity is a genuine data gap (0/null on
      // an otherwise-eligible row — confirmed to happen in real exports),
      // since a real invoice line is never actually zero quantity.
      const billedQty = Number(l.gr_quantity) > 0 ? Number(l.gr_quantity) : Number(l.quantity || 0);
      return {
        item_name: l.material_description,
        qty: billedQty,
        unit: l.unit || "",
        unit_of_measure: l.unit || "",
        hsn_code: l.hsn_code || "",
        rate: billedQty ? roundTo2(billedTaxable / billedQty) : 0,
        amount: roundTo2(billedTaxable),
        godown_name: l.godown_name || "",
        gst_rate: parseGstRatePercent(l.tax_description) ?? deriveGstRateFromAmounts(billedTaxable, billedTax)
      };
    });

    const narration = `Being purchase from ${first.vendor_name} vide invoice ${invoiceNo} dated ${first.invoice_date || ""} (PO: ${poNumbers.join(", ")}) (ODN: ${odnNumbers.join(", ")})`;

    const invoiceData = {
      vendor_name: first.vendor_name,
      gstin: vendorGstin,
      invoice_no: invoiceNo,
      invoice_date: first.invoice_date,
      line_items: lineItems,
      cgst_amount: igstLine ? 0 : roundTo2(taxTotal / 2),
      sgst_amount: igstLine ? 0 : roundTo2(taxTotal / 2),
      igst_amount: igstLine ? roundTo2(taxTotal) : 0,
      tds_amount: 0,
      cess_amount: 0,
      taxable_amount: roundTo2(taxableTotal),
      grand_total: roundedGrandTotal,
      round_off: roundOff,
      narration,
      po_numbers: poNumbers,
      odn_numbers: odnNumbers,
      godown_name: first.godown_name || ""
    };

    const insertResult = await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.invoice_extractions
        (company_id, company_name, vendor_name, gstin, invoice_no, invoice_date, raw_json, sync_status, user_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW(),NOW())
      ON CONFLICT (company_id, invoice_no) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        vendor_name = EXCLUDED.vendor_name,
        gstin = EXCLUDED.gstin,
        invoice_date = EXCLUDED.invoice_date,
        raw_json = EXCLUDED.raw_json,
        sync_status = 'pending',
        error_message = NULL,
        user_id = EXCLUDED.user_id,
        updated_at = NOW()
      RETURNING id
      `,
      [companyId, companyName, first.vendor_name, vendorGstin, invoiceNo, first.invoice_date, JSON.stringify(invoiceData), userId]
    );

    const invoiceId = insertResult.rows[0].id;

    await safeEnqueuePurchase(invoiceId, userId);

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.purchase_po_lines
      SET match_status = 'pushed', invoice_extraction_id = $1, updated_at = NOW()
      WHERE company_id = $2 AND invoice_no = $3 AND match_status = 'matched'
      `,
      [invoiceId, companyId, invoiceNo]
    );

    pushedInvoices.push({ invoiceNo, invoiceId, lineCount: lines.length });
  }

  return pushedInvoices;
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
