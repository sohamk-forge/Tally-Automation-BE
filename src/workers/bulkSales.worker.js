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
  for (const key of possibleKeys) {
    const value = row[String(key).toLowerCase()];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
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

    const { company, filePath } = job.data;

    console.log(`Reading Sales Excel : ${filePath}`);

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
  total: getValue(rows[0], ["total amount"])
});

console.log("================================");

    console.log(`Rows Found : ${rows.length}`);

    const invoices = {};

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
        ])
      });

      if (!invoices[invoiceNo]) {

        const gstin = String(getValue(row, [
          "GSTIN (URC/GSTN)",
          "GSTIN",
          "GST No",
          "GST Number"
        ])).trim();

       const taxableAmount = safeNumber(getValue(row, [
  "Taxable Amount",
  "Taxable Amount INR",
  "Taxable amount",
  "Amount",
  "TaxableValue"
]));

       const totalAmount = safeNumber(getValue(row, [
  "Total Amount",
  "total amount",
  "Grand Total",
  "Total"
]));

        const gstAmount = totalAmount - taxableAmount;
        const stateCode = gstin.substring(0, 2);

        let cgstAmount = 0;
        let sgstAmount = 0;
        let igstAmount = 0;

        // Maharashtra
        if (stateCode === "27") {
          cgstAmount = Number((gstAmount / 2).toFixed(2));
          sgstAmount = Number((gstAmount / 2).toFixed(2));
        } else {
          igstAmount = Number(gstAmount.toFixed(2));
        }

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
          narration: String(getValue(row, [
            "Narration",
            "narration",
            "Remarks"
          ])).trim(),
          godown_name: (() => {
            const godown = getValue(row, [
              "Godown Name",
              "Godown",
              "Location"
            ]);
            return godown && String(godown).trim() ? String(godown).trim() : null;
          })(),
          cgst_amount: cgstAmount,
          sgst_amount: sgstAmount,
          igst_amount: igstAmount,
          grand_total: totalAmount,
          line_items: []
        };
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
          INSERT INTO app_test.sales_invoice_extractions
          (
            company_name,
            customer_name,
            gstin,
            invoice_no,
            invoice_date,
            godown_name,
            raw_json,
            sync_status,
            error_count,
            last_error,
            created_at,
            updated_at
          )
          VALUES
          (
            $1,$2,$3,$4,$5,$6,
            $7,
            'pending',
            0,
            NULL,
            NOW(),
            NOW()
          )
          RETURNING id
          `,
          [
            company,
            invoiceData.customer_name,
            invoiceData.customer_gstin,
            invoiceData.invoice_no,
            invoiceData.invoice_date,
            invoiceData.godown_name,
            invoiceData
          ]
        );

        const salesId = insertResult.rows[0].id;

        await salesQueue.add(
          "sales-invoice",
          { salesId },
          { jobId: getSalesJobId(salesId) }
        );

        console.log(`✅ Sales Queued : ${salesId} (Invoice: ${invoiceNo}, Date: ${invoiceData.invoice_date})`);
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