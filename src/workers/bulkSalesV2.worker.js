import { DB_SCHEMA } from "../config/db.js";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";

import {
  BULK_SALES_QUEUE_NAME_V2
} from "../queues/bulkSalesV2.queue.js";

import {
  salesQueue
} from "../queues/sales.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// This company's own GST state — used only by the SPARE_SALES format,
// which has a single combined Tax Amount column that still needs to be
// split into CGST+SGST vs IGST ourselves. WARRANTY and SPARE_LABOUR both
// arrive with CGST/SGST/IGST already split by the source system, so this
// constant is never consulted for those two formats.
const MY_COMPANY_STATE_NAME = "maharashtra";

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Proper 2-decimal rounding — plain .toFixed(2) mis-rounds values like
// 178.47 / 2 = 89.235 down to 89.23 instead of 89.24 due to floating-point
// representation. Number.EPSILON corrects that.
function roundTo2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

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
    const matchedKey = rowKeys.find(k => k.startsWith(target));
    if (matchedKey && String(row[matchedKey]).trim() !== "") {
      return row[matchedKey];
    }
  }

  return "";
}

// Last-resort fallback: scans EVERY header on the row for one that looks
// like a GST amount column — contains "gst" AND one of the amount-ish
// words (amount/amt/value) — regardless of exact wording. Used when a
// file's tax column doesn't match any of the known named aliases at all
// — e.g. "Total GST Value", "GST Amt (Incl.)" — so the worker still finds
// SOME gst-amount column instead of silently treating tax as zero.
// Deliberately requires an amount-word too, so it can't accidentally
// match an ID/registration column like "Customer GST No" or "GSTIN".
function findGstAmountColumn(row) {
  const rowKeys = Object.keys(row);
  const amountWords = ["amount", "amt", "value"];
  const matchedKey = rowKeys.find(k =>
    k.includes("gst") && amountWords.some(w => k.includes(w))
  );
  return matchedKey ? row[matchedKey] : "";
}

function formatDate(value) {
  if (!value) return "";

  if (typeof value === "number") {
    const excelDate = XLSX.SSF.parse_date_code(value);
    if (!excelDate) return "";
    const day = String(excelDate.d).padStart(2, "0");
    const month = String(excelDate.m).padStart(2, "0");
    const year = excelDate.y;
    return `${day}-${month}-${year}`;
  }

  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, "0");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const year = value.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // Handles plain "2026-04-14" style strings from the Warranty sheet too —
  // formatDate is only cosmetic re-formatting, Date can parse ISO strings.
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(String(value).trim())) {
    const day = String(asDate.getDate()).padStart(2, "0");
    const month = String(asDate.getMonth() + 1).padStart(2, "0");
    const year = asDate.getFullYear();
    return `${day}-${month}-${year}`;
  }

  return String(value).trim();
}

/**
 * Detects which of the 3 known report formats a row belongs to, based on
 * headers that are unique to each. Checked in an order where each check
 * can't be confused with the other two formats.
 */
function detectFormat(row) {
  const keys = Object.keys(row);
  const has = (k) => keys.includes(k);

  // Warranty — DocumentNumber + CentralTaxAmount/IntegratedTaxAmount are
  // unique to this sheet (Spare Sales and Spare+Labour have neither).
  if (has("documentnumber") && has("centraltaxamount") && has("integratedtaxamount")) {
    return "WARRANTY";
  }

  // Spare + Labour — CGST/SGST/IGST Base Value columns are unique to this
  // sheet.
  if (has("cgst base value") && has("sgst base value") && has("igst base value")) {
    return "SPARE_LABOUR";
  }

  // Spare Sales — Net Taxable Amount + Customer GST No together are
  // unique to this sheet (Warranty has neither; Spare+Labour has neither).
  if (has("net taxable amount") && has("customer gst no")) {
    return "SPARE_SALES";
  }

  return null;
}

function ensureInvoice(invoices, invoiceNo, seed) {
  if (!invoices[invoiceNo]) {
    invoices[invoiceNo] = {
      customer_name: seed.customer_name || "",
      customer_gstin: seed.customer_gstin || "",
      invoice_no: invoiceNo,
      invoice_date: seed.invoice_date || "",
      narration: "",
      godown_name: "Main Location",

      taxable_amount: 0,
      grand_total: 0,

      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      tds_amount: 0,
      round_off: 0,

      excel_total: 0,
      has_excel_total: false,

      // SPARE_SALES only — accumulated combined tax, split into
      // cgst/sgst/igst once during finalization (needs customer_state).
      pending_tax_amount: 0,
      customer_state: seed.customer_state || "",

      line_items: []
    };
  }
  return invoices[invoiceNo];
}

// ── Row processors — one per format, each normalizes into the same
// invoice shape and pushes into the shared `invoices` map. ──────────────

function processWarrantyRow(row, invoices) {
  const invoiceNo = String(getValue(row, ["documentnumber"])).trim();
  if (!invoiceNo) return;

  const invoice = ensureInvoice(invoices, invoiceNo, {
    customer_name: String(getValue(row, ["customername"])).trim(),
    customer_gstin: String(getValue(row, ["customergstin"])).trim(),
    invoice_date: formatDate(getValue(row, ["accountingvoucherdate"])),
    customer_state: String(getValue(row, ["shiptostate"])).trim()
  });

  const taxableValue = safeNumber(getValue(row, ["taxablevalue"]));
  const cgstAmount = safeNumber(getValue(row, ["centraltaxamount"]));
  const sgstAmount = safeNumber(getValue(row, ["stateuttaxamount"]));
  const igstAmount = safeNumber(getValue(row, ["integratedtaxamount"]));
  const tdsAmount = Math.abs(safeNumber(getValue(row, ["tds value"])));
  const invoiceValue = safeNumber(getValue(row, ["total invoice value without tds"]));

  invoice.taxable_amount += taxableValue;
  invoice.cgst_amount += cgstAmount;
  invoice.sgst_amount += sgstAmount;
  invoice.igst_amount += igstAmount;
  invoice.tds_amount += tdsAmount;

  if (invoiceValue !== 0) {
    invoice.excel_total += invoiceValue;
    invoice.has_excel_total = true;
  }

  const itemName = String(getValue(row, ["productdescription"])).trim();
  if (itemName) {
    invoice.line_items.push({
      item_name: itemName,
      hsn_code: String(getValue(row, ["hsnorsac"])).trim(),
      quantity: safeNumber(getValue(row, ["quantity"])),
      amount: taxableValue
    });
  }
}

function processSpareLabourRow(row, invoices) {
  const invoiceNo = String(getValue(row, ["dealer invoice number"])).trim();
  if (!invoiceNo) return;

  const invoice = ensureInvoice(invoices, invoiceNo, {
    customer_name: String(getValue(row, ["bill to customer name"])).trim(),
    customer_gstin: String(getValue(row, [
      "customers gstin/ /unique id issued to un"
    ])).trim(),
    invoice_date: formatDate(getValue(row, ["document date"])),
    // No dedicated "Customer State" mapping for this format (already
    // split CGST/SGST/IGST — state isn't needed for calculation), but
    // the state name is available if ever needed for reporting.
    customer_state: String(getValue(row, ["customer bill to state name"])).trim()
  });

  const cgstBase = safeNumber(getValue(row, ["cgst base value"]));
  const sgstBase = safeNumber(getValue(row, ["sgst base value"]));
  const igstBase = safeNumber(getValue(row, ["igst base value"]));
  // Exactly one of these is nonzero per line (intrastate uses cgst/sgst
  // base, interstate uses igst base) — taxable amount is whichever applies.
  const taxableValue = cgstBase || sgstBase || igstBase;

  const cgstAmount = safeNumber(getValue(row, ["cgst amt"]));
  const sgstAmount = safeNumber(getValue(row, ["sgst amt"]));
  const igstAmount = safeNumber(getValue(row, ["igst amt"]));

  const invoiceValue = safeNumber(getValue(row, ["invoice value"]));

  invoice.taxable_amount += taxableValue;
  invoice.cgst_amount += cgstAmount;
  invoice.sgst_amount += sgstAmount;
  invoice.igst_amount += igstAmount;
  // No TDS column in this format.

  if (invoiceValue !== 0) {
    invoice.excel_total += invoiceValue;
    invoice.has_excel_total = true;
  }

  const itemName = String(getValue(row, ["description of item"])).trim();
  if (itemName) {
    invoice.line_items.push({
      item_name: itemName,
      hsn_code: String(getValue(row, [
        "hsn for goods/ service accounting code f"
      ])).trim(),
      quantity: safeNumber(getValue(row, ["quantity (as supplied)"])),
      amount: taxableValue
    });
  }
}

function processSpareSalesRow(row, invoices) {
  const invoiceNo = String(getValue(row, ["dealer invoice number"])).trim();
  if (!invoiceNo) return;

  const invoice = ensureInvoice(invoices, invoiceNo, {
    customer_name: String(getValue(row, ["customer name"])).trim(),
    customer_gstin: String(getValue(row, ["customer gst no"])).trim(),
    invoice_date: formatDate(getValue(row, ["invoice date"])),
    customer_state: String(getValue(row, ["customer state"])).trim()
  });

  const taxableValue = safeNumber(getValue(row, ["net taxable amount"]));

  // Combined tax — split happens later during finalization, once per
  // invoice, using invoice.customer_state. Tries the known exact header
  // first ("Tax Amount"); if that's missing (different export naming),
  // falls back to any column that looks like a GST amount — e.g. "Total
  // GST Value", "GST Amt" — so a differently-named GST column still gets
  // picked up instead of silently defaulting to zero tax. Won't match
  // "Customer GST No"/"GSTIN" since those don't contain an amount word.
  const rawTaxAmount = getValue(row, ["tax amount"]) ||
    findGstAmountColumn(row);
  const taxAmount = safeNumber(rawTaxAmount);
  const netAmount = safeNumber(getValue(row, ["net amount"]));

  invoice.taxable_amount += taxableValue;
  invoice.pending_tax_amount += taxAmount;
  // No TDS column in this format.

  if (netAmount !== 0) {
    invoice.excel_total += netAmount;
    invoice.has_excel_total = true;
  }

  const itemName = String(getValue(row, ["item description"])).trim();
  if (itemName) {
    invoice.line_items.push({
      item_name: itemName,
      hsn_code: String(getValue(row, ["hsn code"])).trim(),
      quantity: safeNumber(getValue(row, ["quantity billed"])),
      amount: taxableValue
    });
  }
}

const worker = new Worker(
  BULK_SALES_QUEUE_NAME_V2,

  async (job) => {

    const { company, filePath, userId, companyId: companyIdFromJob } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for bulk sales V2 job ${job.id}`);
    }

    console.log(`Reading Sales Excel (multi-format) : ${filePath}`, { userId });

    // The route now resolves and passes companyId directly (it already
    // looked the company up to validate the upload before queuing) — use
    // that instead of re-querying, but still fall back to a name lookup
    // for backward compatibility if an older caller only sends `company`.
    let companyId = companyIdFromJob;

    if (!companyId) {
      const companyResult = await pool.query(
        `
        SELECT id
        FROM ${DB_SCHEMA}.companies
        WHERE TRIM(name) = TRIM($1)
        LIMIT 1
        `,
        [company]
      );

      companyId = companyResult.rows[0]?.id;
    }

    if (!companyId) {
      throw new Error(`Company not found: ${company}`);
    }

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const rows = rawRows.map(row => {
      const normalized = {};
      Object.keys(row).forEach(key => {
        const cleanKey = String(key)
          .replace(/\r?\n/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        normalized[cleanKey] = row[key];
      });
      return normalized;
    });

    console.log(`Rows Found : ${rows.length}`);

    if (!rows.length) {
      return { processedRows: 0, successCount: 0, failCount: 0 };
    }

    const format = detectFormat(rows[0]);

    if (!format) {
      throw new Error(
        "Could not detect Excel format — expected headers matching Spare Sales, Spare+Labour, or Warranty GST report layouts."
      );
    }

    console.log(`📄 Detected format: ${format}`);

    const invoices = {};
    let skippedRows = 0;

    for (const row of rows) {
      if (format === "WARRANTY") {
        processWarrantyRow(row, invoices);
      } else if (format === "SPARE_LABOUR") {
        processSpareLabourRow(row, invoices);
      } else if (format === "SPARE_SALES") {
        processSpareSalesRow(row, invoices);
      }
    }

    // ── Finalize each invoice: split SPARE_SALES combined tax, reconcile
    // round-off against the source's own grand total, same pattern as the
    // original bulk sales worker. ────────────────────────────────────────
    Object.values(invoices).forEach(invoice => {

      if (format === "SPARE_SALES") {
        const taxAmount = roundTo2(invoice.pending_tax_amount);
        const stateName = String(invoice.customer_state || "").trim().toLowerCase();

        if (!stateName || stateName === MY_COMPANY_STATE_NAME) {
          // Compute SGST as the remainder (taxAmount - cgst) rather than
          // halving twice — guarantees cgst + sgst always equals the
          // original taxAmount exactly, even when taxAmount is an odd
          // number of paisa (e.g. 178.47 → 89.24 + 89.23 = 178.47, not
          // 89.24 + 89.24 = 178.48).
          const cgst = roundTo2(taxAmount / 2);
          const sgst = roundTo2(taxAmount - cgst);

          invoice.cgst_amount = cgst;
          invoice.sgst_amount = sgst;
          invoice.igst_amount = 0;
        } else {
          invoice.cgst_amount = 0;
          invoice.sgst_amount = 0;
          invoice.igst_amount = taxAmount;
        }
      } else {
        // WARRANTY / SPARE_LABOUR already accumulated cgst/sgst/igst
        // directly from the source's own split columns — just round them.
        invoice.cgst_amount = roundTo2(invoice.cgst_amount);
        invoice.sgst_amount = roundTo2(invoice.sgst_amount);
        invoice.igst_amount = roundTo2(invoice.igst_amount);
      }

      const baseTotal = roundTo2(
        invoice.taxable_amount +
        invoice.cgst_amount +
        invoice.sgst_amount +
        invoice.igst_amount -
        invoice.tds_amount
      );

      if (invoice.has_excel_total) {
        invoice.round_off = roundTo2(invoice.excel_total - baseTotal);
        invoice.grand_total = roundTo2(invoice.excel_total);
      } else {
        invoice.round_off = 0;
        invoice.grand_total = baseTotal;
      }

      console.log("FINAL GST CHECK (V2)", {
        format,
        invoice: invoice.invoice_no,
        customer_state: invoice.customer_state || "—",
        taxable: invoice.taxable_amount,
        cgst: invoice.cgst_amount,
        sgst: invoice.sgst_amount,
        igst: invoice.igst_amount,
        tds: invoice.tds_amount,
        excel_total: invoice.excel_total,
        round_off: invoice.round_off,
        grand_total: invoice.grand_total
      });
    });

    let successCount = 0;
    let failCount = 0;

    for (const invoiceNo of Object.keys(invoices)) {
      try {
        const invoiceData = invoices[invoiceNo];

        if (invoiceData.line_items.length === 0) {
          console.log(`Skipping invoice ${invoiceNo} - no line items`);
          skippedRows++;
          continue;
        }

        const insertResult = await pool.query(
          `
          INSERT INTO ${DB_SCHEMA}.sales_invoice_extractions
          (
              company_id, company_name, customer_name, gstin,
              invoice_no, invoice_date, godown_name, raw_json,
              sync_status, error_count, last_error, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,NULL,NOW(),NOW())
          ON CONFLICT (company_id, invoice_no)
          DO UPDATE
          SET
              customer_name = EXCLUDED.customer_name,
              gstin = EXCLUDED.gstin,
              invoice_date = EXCLUDED.invoice_date,
              godown_name = EXCLUDED.godown_name,
              raw_json = EXCLUDED.raw_json,
              sync_status = 'pending',
              error_count = 0,
              last_error = NULL,
              updated_at = NOW()
          RETURNING id;
          `,
          [companyId, company, invoiceData.customer_name, invoiceData.customer_gstin,
          invoiceData.invoice_no, invoiceData.invoice_date, invoiceData.godown_name, invoiceData]
        );

        if (!insertResult.rows.length) {
          console.log(`⚠️ Skipping duplicate invoice: ${invoiceNo}`);
          continue;
        }

        const salesId = insertResult.rows[0].id;

        await salesQueue.add(
          "sales-invoice",
          { salesId, userId },
          { jobId: `${salesId}-${Date.now()}` }
        );

        console.log(`✅ Sales Queued (V2/${format}) : ${salesId} (Invoice: ${invoiceNo}, User: ${userId})`);
        successCount++;

      } catch (error) {
        console.error(`❌ Sales Insert Failed for ${invoiceNo}:`, error.message);
        failCount++;
      }
    }

    console.log(`📊 Bulk Sales V2 Done -> Format:${format} Success:${successCount} Failed:${failCount} SkippedNoItems:${skippedRows}`);

    return {
      format,
      processedRows: rows.length,
      successCount,
      failCount
    };
  },

  {
    connection,
    concurrency: 1
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Bulk Sales V2 Job Completed : ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`❌ Bulk Sales V2 Job Failed : ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("❌ Bulk Sales V2 Worker Error:", error.message);
});

console.log("🚀 Bulk Sales V2 (Multi-Format) Worker Started");

export default worker;