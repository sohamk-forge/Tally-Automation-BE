import { DB_SCHEMA } from "../config/db.js";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";

import {
  BULK_SALES_QUEUE_NAME
} from "../queues/bulkSales.queue.js";

import {
  salesQueue,
  getSalesJobId
} from "../queues/sales.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Helper to get value from multiple possible header names
function getValue(row, possibleKeys) {
  const rowKeys = Object.keys(row);

  for (const key of possibleKeys) {
    const target = String(key).toLowerCase();

    // Exact match first
    if (row[target] !== undefined && String(row[target]).trim() !== "") {
      return row[target];
    }

    // Fallback: header that starts with the target text
    const matchedKey = rowKeys.find(k => k.startsWith(target));
    if (matchedKey && String(row[matchedKey]).trim() !== "") {
      return row[matchedKey];
    }
  }

  return "";
}

// Format date from Excel (handles Date objects and strings)
function formatDate(value) {
  if (!value) return "";

  // Excel serial date (45748, 45749, etc.)
  if (typeof value === "number") {
    const excelDate = XLSX.SSF.parse_date_code(value);

    if (!excelDate) return "";

    const day = String(excelDate.d).padStart(2, "0");
    const month = String(excelDate.m).padStart(2, "0");
    const year = excelDate.y;

    return `${day}-${month}-${year}`;
  }

  // JS Date object
  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, "0");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const year = value.getFullYear();

    return `${day}-${month}-${year}`;
  }

  return String(value).trim();
}

const worker = new Worker(
  BULK_SALES_QUEUE_NAME,

  async (job) => {

    // userId comes from the upload route's verifySession() and must be
    // forwarded onto every salesQueue job below. Without it,
    // pushSalesInvoice.worker calls resolveConnectorForCompany() with no
    // acting user, the acting-user-first branch is skipped, and every
    // invoice from this upload routes by fallback — i.e. into whichever
    // connector for that company happens to be live, which may be someone
    // else's Tally entirely.
    const { company, filePath, userId } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for bulk sales job ${job.id}`);
    }

    console.log(`Reading Sales Excel : ${filePath}`, { userId });

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

    // DEBUG: Print actual headers from Excel
    console.log("================================");
    console.log("EXACT HEADERS FROM EXCEL:");
    console.log("================================");
    if (rows[0]) {
      Object.keys(rows[0]).forEach(header => {
        console.log(`[${header}]`);
      });
    }
    console.log("================================");
    console.log("FIRST ROW SAMPLE:");
    console.log("================================");
    console.log(rows[0]);

    console.log("TEST VALUES:");
    console.log({
      invoiceNo: getValue(rows[0], ["invoice number"]),
      invoiceDate: getValue(rows[0], ["invoice date (dd-mm-yyyy)"]),
      quantity: getValue(rows[0], ["quantity"]),
      rate: getValue(rows[0], ["rate"]),
      taxable: getValue(rows[0], ["taxable amount inr"]),
      total: getValue(rows[0], ["total amount"]),
      roundOff: getValue(rows[0], ["round off"])
    });

    console.log("================================");

    console.log(`Rows Found : ${rows.length}`);

    const invoices = {};

    // Diagnostic-only accumulators, keyed by invoice number. These do NOT
    // affect invoice.tds_amount or invoice.excel_total — they exist purely
    // so the "FINAL GST CHECK" log can show you both the sum interpretation
    // and the last-value interpretation side by side. We got burned once
    // (₹6,000, then ₹13,000) by assuming a repeated invoice-level Excel
    // field was safe to sum with +=. This log lets you catch that pattern
    // by eye before a bad batch reaches Tally, without changing behavior.
    const tdsRowValues = {};

    for (const row of rows) {

      // Get invoice number with multiple possible header names
      const invoiceNo = String(getValue(row, [
        "invoice number",
        "invoice no",
        "invoiceno",
        "invoice_number"
      ])).trim();

      if (!invoiceNo) {
        continue;
      }

      // Debug invoice fields
      console.log("Invoice Debug:", {
        invoiceNo,
        invoiceDate: getValue(row, [
          "Invoice Date",
          "Invoice Date (dd-mm-yyyy)",
          "Invoice date",
          "Date",
          "InvoiceDate"
        ]),
        quantity: getValue(row, [
          "Quantity",
          "Qty",
          "quantity",
          "qty"
        ]),
        rate: getValue(row, [
          "Rate",
          "rate",
          "Unit Price"
        ]),
        taxableAmount: getValue(row, [
          "Taxable Amount",
          "Taxable amount",
          "Amount"
        ]),
        roundOff: getValue(row, [
          "Round Off",
          "RoundOff",
          "Round off",
          "Round Off Amount"
        ])
      });

      if (!invoices[invoiceNo]) {

        const gstin = String(getValue(row, [
          "GSTIN (URC/GSTN) optional",
          "GSTIN (URC/GSTN)",
          "GSTIN",
          "GST No",
          "GST Number"
        ])).trim();

        invoices[invoiceNo] = {
          customer_name: String(getValue(row, [
            "Party Name",
            "Party",
            "Customer Name",
            "Customer"
          ])).trim(),

          customer_gstin: gstin,
          invoice_no: invoiceNo,

          invoice_date: formatDate(getValue(row, [
            "invoice date",
            "invoice date (dd-mm-yyyy)",
            "date"
          ])),

          narration: "",

          godown_name: (() => {
            const godown = getValue(row, [
              "Godown Name",
              "Godown",
              "Location"
            ]);

            return godown && String(godown).trim()
              ? String(godown).trim()
              : "Main Location";
          })(),

          taxable_amount: 0,
          grand_total: 0,
          gst_percent: 0,

          cgst_amount: 0,
          sgst_amount: 0,
          igst_amount: 0,
          tds_amount: 0,
          round_off: 0,

          // ✅ NEW — Excel-total tracking for paisa reconciliation
          excel_total: 0,
          has_excel_total: false,
          has_round_off: false,

          line_items: []
        };

        tdsRowValues[invoiceNo] = [];
      }

      const taxableAmount = safeNumber(getValue(row, [
        "Taxable Amount",
        "Taxable Amount INR",
        "Taxable amount",
        "Taxable Value",
        "Taxable value",
        "TaxableValue",
        "Amount"   // keep as last-resort fallback only
      ]));

      const gstPercent = safeNumber(getValue(row, [
        // Exact/possible Excel headers
        "GST Rate(%) 0, 3, 5, 12, 18, 28",
        "GST Rate(%) 0, 5, 12, 18, 28",
        "GST Rate(%) 0,3,5,12,18,28",
        "GST Rate(%) 0,5,12,18,28",
        "GST Rate (%) 0,3,5,12,18,28",

        // Generic headers
        "GST %",
        "GST Percentage",
        "GST Rate",
        "Gst %",
        "GST"
      ]));

      const tdsAmount = Math.abs(safeNumber(getValue(row, [
        "TDS",
        "TDS Amount",
        "TDS Amt",
        "TDS Amount INR"
      ])));

      // ✅ NEW — Total Amount, read per row (invoice-level field per your
      // confirmation on this Excel; summed below because it's line-level
      // for multi-item invoices in this template)
      const excelTotalAmount = safeNumber(getValue(row, [
        "Total Amount",
        "Total Amount INR",
        "Grand Total",
        "Invoice Total"
      ]));

      const rawRoundOff = getValue(row, [
        "Round Off",
        "RoundOff",
        "Round off",
        "Round Off Amount"
      ]);

      const hasRoundOffValue =
        rawRoundOff !== "" &&
        rawRoundOff !== null &&
        rawRoundOff !== undefined;

      const roundOff = safeNumber(rawRoundOff);

      invoices[invoiceNo].taxable_amount += taxableAmount;

      if (invoices[invoiceNo].gst_percent === 0) {
        invoices[invoiceNo].gst_percent = gstPercent || 18;
      }

      // TDS kept as-is (summed). NOT CONFIRMED whether TDS repeats per row
      // in this Excel — see tdsRowValues diagnostic below and check the
      // "FINAL GST CHECK" log before trusting this on a new invoice format.
      invoices[invoiceNo].tds_amount += tdsAmount;
      tdsRowValues[invoiceNo].push(tdsAmount);

      // ✅ NEW — Total Amount summed across rows (line-level for this Excel)
      if (excelTotalAmount !== 0) {
        invoices[invoiceNo].excel_total += excelTotalAmount;
        invoices[invoiceNo].has_excel_total = true;
      }

      // Round Off overwritten (invoice-level, same value repeats per row)
      if (hasRoundOffValue) {
        invoices[invoiceNo].round_off = roundOff;
        invoices[invoiceNo].has_round_off = true;
      }

      // Get line item details
      const itemName = String(getValue(row, [
        "Particulars",
        "Item Name",
        "Product",
        "Description"
      ])).trim();

      // Only push if there's an item name
      if (itemName) {
        invoices[invoiceNo].line_items.push({
          item_name: itemName,
          quantity: safeNumber(getValue(row, [
            "Quantity",
            "Qty",
            "quantity",
            "qty"
          ])),
          rate: safeNumber(getValue(row, [
            "Rate",
            "rate",
            "Unit Price",
            "Price"
          ])),
          amount: safeNumber(getValue(row, [
            "Taxable Amount",
            "Taxable Amount INR",
            "Amount",
            "taxable amount"
          ]))
        });
      }
    }


    Object.values(invoices).forEach(invoice => {

      // Step 1 + 2: Taxable → Calculate GST yourself
      const gstAmount = Number(
        ((invoice.taxable_amount * invoice.gst_percent) / 100).toFixed(2)
      );

      const stateCode = String(invoice.customer_gstin || "")
        .trim()
        .substring(0, 2);

      if (stateCode === "27") {

        const halfRate = invoice.gst_percent / 2;

        invoice.cgst_amount = Number(
          ((invoice.taxable_amount * halfRate) / 100).toFixed(2)
        );

        invoice.sgst_amount = Number(
          ((invoice.taxable_amount * halfRate) / 100).toFixed(2)
        );

        invoice.igst_amount = 0;

      } else if (stateCode) {

        invoice.cgst_amount = 0;
        invoice.sgst_amount = 0;
        invoice.igst_amount = gstAmount;

      } else {

        const halfRate = invoice.gst_percent / 2;

        invoice.cgst_amount = Number(
          ((invoice.taxable_amount * halfRate) / 100).toFixed(2)
        );

        invoice.sgst_amount = Number(
          ((invoice.taxable_amount * halfRate) / 100).toFixed(2)
        );

        invoice.igst_amount = 0;
      }

      // Step 4: Subtract TDS
      const baseTotal = Number((
        invoice.taxable_amount +
        invoice.cgst_amount +
        invoice.sgst_amount +
        invoice.igst_amount -
        invoice.tds_amount
      ).toFixed(2));

      // ✅ UPDATED — Step 5: Grand Total reconciliation
      //
      // Fix: an explicit Round Off of 0 used to short-circuit reconciliation
      // even when Excel's Total Amount implied a nonzero adjustment (e.g.
      // invoice 5930052600299: explicit Round Off = 0, but Excel Total
      // required +0.02 to reach 2435.05, and the old branch order returned
      // 2435.03 instead). Excel's Total Amount, when present, is the ground
      // truth for what the invoice must equal — so it now takes priority.
      // An explicit Round Off is still used to double check: if it disagrees
      // with what the Total Amount implies, we log it instead of trusting
      // the (possibly stale/placeholder) Round Off cell silently.
      if (invoice.has_excel_total) {

        const derivedRoundOff = Number(
          (invoice.excel_total - baseTotal).toFixed(2)
        );

        if (invoice.has_round_off &&
            Math.abs(invoice.round_off - derivedRoundOff) > 0.001) {
          console.log("⚠️ ROUND OFF MISMATCH — Excel Round Off cell disagrees with Excel Total Amount, using Total Amount as source of truth:", {
            invoice: invoice.invoice_no,
            excel_round_off_cell: invoice.round_off,
            derived_round_off_from_total: derivedRoundOff,
            base_total: baseTotal,
            excel_total: invoice.excel_total
          });
        }

        invoice.round_off = derivedRoundOff;
        invoice.grand_total = Number(
          invoice.excel_total.toFixed(2)
        );

      } else if (invoice.has_round_off) {

        // No Excel Total to reconcile against — trust the explicit Round Off.
        invoice.grand_total = Number(
          (baseTotal + invoice.round_off).toFixed(2)
        );

      } else {

        invoice.round_off = 0;
        invoice.grand_total = baseTotal;
      }

      // DIAGNOSTIC ONLY — does not affect invoice.tds_amount. Compares the
      // "sum all rows" value already stored against the "last row only"
      // value. If these two numbers differ for a multi-item invoice, TDS is
      // very likely an invoice-level field repeated per row in this Excel
      // (the same pattern that caused the earlier excel_total bug), and
      // invoice.tds_amount is currently inflated by a multiple of the true
      // TDS. Check this log against the Excel before trusting the total.
      const tdsRows = tdsRowValues[invoice.invoice_no] || [];
      const tdsLastRowOnly = tdsRows.length ? tdsRows[tdsRows.length - 1] : 0;
      if (tdsRows.length > 1 && tdsLastRowOnly !== 0 &&
          Math.abs(invoice.tds_amount - tdsLastRowOnly) > 0.001) {
        console.log("⚠️ TDS SUM-VS-SINGLE MISMATCH — verify against Excel:", {
          invoice: invoice.invoice_no,
          row_count: tdsRows.length,
          tds_summed_all_rows: Number(invoice.tds_amount.toFixed(2)),
          tds_if_single_value: tdsLastRowOnly,
          row_values: tdsRows
        });
      }

      console.log("FINAL GST CHECK", {
        invoice: invoice.invoice_no,
        taxable: invoice.taxable_amount,
        gst_percent: invoice.gst_percent,
        gst: gstAmount,
        cgst: invoice.cgst_amount,
        sgst: invoice.sgst_amount,
        igst: invoice.igst_amount,
        tds: invoice.tds_amount,
        excel_total: invoice.excel_total,
        has_excel_total: invoice.has_excel_total,
        round_off: invoice.round_off,
        has_round_off: invoice.has_round_off,
        grand_total: invoice.grand_total
      });
    });

    // Resolve the company once, not once per invoice — the name never changes
    // inside a single upload.
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
      throw new Error(`Company not found: ${company}`);
    }

    let successCount = 0;
    let failCount = 0;
    for (const invoiceNo of Object.keys(invoices)) {
      try {
        const invoiceData = invoices[invoiceNo];

        // Skip if no line items
        if (invoiceData.line_items.length === 0) {
          console.log(`Skipping invoice ${invoiceNo} - no line items`);
          continue;
        }

        // Skip if missing required fields
        if (!invoiceData.invoice_date) {
          console.log(`⚠️ Warning: Invoice ${invoiceNo} has no invoice date`);
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

        // If duplicate, RETURNING id gives nothing - skip queuing
        if (!insertResult.rows.length) {
          console.log(`⚠️ Skipping duplicate invoice: ${invoiceNo}`);
          continue;
        }

        const salesId = insertResult.rows[0].id;

        // The job id MUST be unique per push.
        //
        // This used to be getSalesJobId(salesId) — a fixed id per invoice — with a
        // getJob()/remove() dance in front of it. BullMQ SILENTLY IGNORES add() when
        // a job with that id already exists, and removeOnComplete keeps recent
        // completed jobs around, so re-uploading a spreadsheet enqueued nothing at
        // all for any invoice already pushed once: this worker logged "Sales Queued"
        // and the sales worker never ran.
        //
        // Duplicate processing is not a risk: pushSalesInvoice.worker skips when a
        // 'pending' or 'processing' connector job already exists for the invoice.
        await salesQueue.add(
          "sales-invoice",
          {
            salesId,

            // Owner of this upload — carried through so the sales worker can route
            // to THIS user's connector rather than falling back to any live one.
            userId
          },
          { jobId: `${salesId}-${Date.now()}` }
        );

        console.log(`✅ Sales Queued : ${salesId} (Invoice: ${invoiceNo}, Date: ${invoiceData.invoice_date}, User: ${userId})`);
        successCount++;

      } catch (error) {
        console.error(`❌ Sales Insert Failed for ${invoiceNo}:`, error.message);
        failCount++;
      }
    }

    console.log(`📊 Bulk Sales Done -> Success:${successCount} Failed:${failCount}`);

    return {
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
  console.log(`✅ Bulk Sales Job Completed : ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`❌ Bulk Sales Job Failed : ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("❌ Bulk Sales Worker Error:", error.message);
});

console.log("🚀 Bulk Sales Worker Started");

export default worker;