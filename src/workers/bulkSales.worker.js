import { DB_SCHEMA } from "../config/db.js";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";

import {
  BULK_SALES_QUEUE_NAME
} from "../queues/bulkSales.queue.js";

import {
  safeEnqueueSales
} from "../queues/sales.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// This company's own GST state code — Sai Sanjivani Enterprise (Eicher
// Workshop) is registered in Maharashtra. Intentionally hardcoded here
// (not looked up from company_details) per explicit instruction: no
// company GSTIN/state DB lookup for this worker.
const MY_COMPANY_STATE_CODE = "27";

// Every valid 2-digit Indian GST state/UT code. Used only to validate that
// a customer's GSTIN prefix is a real state code before trusting it as
// "this customer is in a different state" — a garbage/malformed GSTIN
// prefix (or one that isn't a real code) is treated the same as "no
// GSTIN" (unregistered/local), which falls into the CGST+SGST branch,
// not silently misrouted into IGST.
const VALID_GST_STATE_CODES = new Set([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
  "21", "22", "23", "24", "25", "26", "27", "28", "29", "30",
  "31", "32", "33", "34", "35", "36", "37", "38", "97"
]);

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Proper 2-decimal rounding — .toFixed(2) alone is unreliable for values
// like 178.47 / 2 = 89.235, which JS's floating-point toFixed rounds DOWN
// to 89.23 instead of 89.24. This uses Number.EPSILON to correct that.
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

  return String(value).trim();
}

const worker = new Worker(
  BULK_SALES_QUEUE_NAME,

  async (job) => {

    // companyId comes from job.data — already resolved and user-scoped by
    // bulkSalesUpload.routes.js before this job was enqueued. Re-resolving
    // it here by a bare name match (as this used to do) reintroduces the
    // exact company name-collision bug already fixed at the route layer:
    // two different users' companies can share a name, and an unscoped
    // lookup can silently pick the wrong one.
    const { company, companyId, filePath, userId } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for bulk sales job ${job.id}`);
    }

    if (!companyId) {
      throw new Error(`Missing companyId for bulk sales job ${job.id} (company: ${company})`);
    }

    console.log(`[BULK-SALES] Processing job ${job.id} — reading Excel: ${filePath}`, { userId, companyId });

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

    console.log("================================");
    console.log("EXACT HEADERS FROM EXCEL:");
    console.log("================================");
    if (rows[0]) {
      Object.keys(rows[0]).forEach(header => {
        console.log(`[${header}]`);
      });
    }
    console.log("================================");
    console.log(`Rows Found : ${rows.length}`);

    const invoices = {};

    for (const row of rows) {

      const invoiceNo = String(getValue(row, [
        "invoice number",
        "invoice no",
        "invoiceno",
        "invoice_number"
      ])).trim();

      if (!invoiceNo) {
        continue;
      }

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

          tax_amount: 0,

          cgst_amount: 0,
          sgst_amount: 0,
          igst_amount: 0,
          tds_amount: 0,
          round_off: 0,

          excel_total: 0,
          has_excel_total: false,
          has_round_off: false,

          line_items: []
        };
      }

      const invoice = invoices[invoiceNo];

      const taxableAmount = safeNumber(getValue(row, [
        "Taxable Amount",
        "Taxable Amount INR",
        "Taxable amount",
        "Taxable Value",
        "Taxable value",
        "TaxableValue",
        "Amount"
      ]));

      // ✅ Source of truth for tax — Excel's own "TAX AMOUNT" column,
      // summed at the invoice level. No taxable × rate calculation
      // anywhere in this file anymore.
      const taxAmount = safeNumber(getValue(row, [
        "TAX AMOUNT",
        "Tax Amount",
        "GST Amount",
        "Tax Amt"
      ]));

      const tdsAmount = Math.abs(safeNumber(getValue(row, [
        "TDS",
        "TDS Amount",
        "TDS Amt",
        "TDS Amount INR"
      ])));

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

      invoice.taxable_amount += taxableAmount;
      invoice.tax_amount += taxAmount;
      invoice.tds_amount += tdsAmount;

      if (excelTotalAmount !== 0) {
        invoice.excel_total += excelTotalAmount;
        invoice.has_excel_total = true;
      }

      if (hasRoundOffValue) {
        invoice.round_off = roundOff;
        invoice.has_round_off = true;
      }

      const itemName = String(getValue(row, [
        "Particulars",
        "Item Name",
        "Product",
        "Description"
      ])).trim();

      if (itemName) {
        invoice.line_items.push({
          item_name: itemName,
          quantity: safeNumber(getValue(row, [
            "Quantity", "Qty", "quantity", "qty"
          ])),
          rate: safeNumber(getValue(row, [
            "Rate", "rate", "Unit Price", "Price"
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

      const taxAmount = roundTo2(invoice.tax_amount);

      const rawStateCode = String(invoice.customer_gstin || "")
        .trim()
        .substring(0, 2);

      // Only trust the prefix as a real state code if it's actually one
      // of the 38 valid Indian GST codes — anything else (blank, "NA",
      // a malformed GSTIN) is treated as unregistered/local, same as
      // Maharashtra, i.e. CGST+SGST.
      const stateCode = VALID_GST_STATE_CODES.has(rawStateCode) ? rawStateCode : "";

      if (stateCode === MY_COMPANY_STATE_CODE || !stateCode) {

        // Intrastate (or unregistered/local customer) — split in half
        const cgst = roundTo2(taxAmount / 2);
const sgst = roundTo2(taxAmount - cgst);

invoice.cgst_amount = cgst;
invoice.sgst_amount = sgst;
invoice.igst_amount = 0;

      } else {

        // Interstate — any other valid state code goes fully to IGST
        invoice.cgst_amount = 0;
        invoice.sgst_amount = 0;
        invoice.igst_amount = taxAmount;
      }

      // Step 4: Subtract TDS
      const baseTotal = roundTo2(
        invoice.taxable_amount +
        invoice.cgst_amount +
        invoice.sgst_amount +
        invoice.igst_amount -
        invoice.tds_amount
      );

      if (invoice.has_excel_total) {

        const derivedRoundOff = roundTo2(invoice.excel_total - baseTotal);

        if (invoice.has_round_off &&
            Math.abs(invoice.round_off - derivedRoundOff) > 0.001) {
          console.log("⚠️ ROUND OFF MISMATCH — using Excel Total Amount as source of truth:", {
            invoice: invoice.invoice_no,
            excel_round_off_cell: invoice.round_off,
            derived_round_off_from_total: derivedRoundOff,
            base_total: baseTotal,
            excel_total: invoice.excel_total
          });
        }

        invoice.round_off = derivedRoundOff;
        invoice.grand_total = roundTo2(invoice.excel_total);

      } else if (invoice.has_round_off) {

        invoice.grand_total = roundTo2(baseTotal + invoice.round_off);

      } else {

        invoice.round_off = 0;
        invoice.grand_total = baseTotal;
      }

      console.log("FINAL GST CHECK", {
        invoice: invoice.invoice_no,
        customer_gstin: invoice.customer_gstin || "—",
        customer_state_code: stateCode || "unregistered/local",
        my_company_state_code: MY_COMPANY_STATE_CODE,
        is_intrastate: stateCode === MY_COMPANY_STATE_CODE || !stateCode,
        taxable: invoice.taxable_amount,
        tax_amount: taxAmount,
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

    let successCount = 0;
    let failCount = 0;
    for (const invoiceNo of Object.keys(invoices)) {
      try {
        const invoiceData = invoices[invoiceNo];

        if (invoiceData.line_items.length === 0) {
          console.log(`Skipping invoice ${invoiceNo} - no line items`);
          continue;
        }

        if (!invoiceData.invoice_date) {
          console.log(`⚠️ Warning: Invoice ${invoiceNo} has no invoice date`);
        }

        const insertResult = await pool.query(
          `
          INSERT INTO ${DB_SCHEMA}.sales_invoice_extractions
          (
              company_id, company_name, customer_name, gstin,
              invoice_no, invoice_date, godown_name, raw_json,
              sync_status, error_count, last_error, user_id, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,NULL,$9,NOW(),NOW())
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
              user_id = EXCLUDED.user_id,
              updated_at = NOW()
          RETURNING id;
          `,
          [companyId, company, invoiceData.customer_name, invoiceData.customer_gstin,
          invoiceData.invoice_no, invoiceData.invoice_date, invoiceData.godown_name, invoiceData, userId]
        );

        if (!insertResult.rows.length) {
          console.log(`⚠️ Skipping duplicate invoice: ${invoiceNo}`);
          continue;
        }

        const salesId = insertResult.rows[0].id;

        await safeEnqueueSales(salesId, userId);

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
  console.log(`[BULK-SALES] ✅ Job completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[BULK-SALES] ❌ Job failed: ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("[BULK-SALES] ❌ Worker error:", error.message);
});

console.log("🚀 Bulk Sales Worker Started");

export default worker;