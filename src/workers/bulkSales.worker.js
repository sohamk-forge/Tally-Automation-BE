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
        : null;
    })(),

    taxable_amount: 0,
    grand_total: 0,

    cgst_amount: 0,
    sgst_amount: 0,
    igst_amount: 0,

    line_items: []
  };
}

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

invoices[invoiceNo].taxable_amount += taxableAmount;
invoices[invoiceNo].grand_total += totalAmount;

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

  const gstAmount =
    invoice.grand_total - invoice.taxable_amount;

  const stateCode =
    invoice.customer_gstin?.substring(0, 2);

  if (stateCode === "27" || !stateCode) {   // ← ONLY THIS LINE CHANGED

    invoice.cgst_amount =
      Number((gstAmount / 2).toFixed(2));

    invoice.sgst_amount =
      Number((gstAmount - invoice.cgst_amount).toFixed(2));

    invoice.igst_amount = 0;

  } else {

    invoice.cgst_amount = 0;
    invoice.sgst_amount = 0;

    invoice.igst_amount =
      Number(gstAmount.toFixed(2));
  }

  console.log("FINAL GST CHECK", {
    invoice: invoice.invoice_no,
    taxable: invoice.taxable_amount,
    grand_total: invoice.grand_total,
    gst: gstAmount,
    cgst: invoice.cgst_amount,
    sgst: invoice.sgst_amount,
    igst: invoice.igst_amount
  });

});
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
        const companyResult = await pool.query(
  `
  SELECT id
  FROM app_test.companies
  WHERE TRIM(name) = TRIM($1)
  LIMIT 1
  `,
  [company]
);

const companyId = companyResult.rows[0]?.id;

if (!companyId) {
  throw new Error(`Company not found: ${company}`);
}

   const insertResult = await pool.query(
  `
  INSERT INTO app_test.sales_invoice_extractions
  (
      company_id, company_name, customer_name, gstin,
      invoice_no, invoice_date, godown_name, raw_json,
      sync_status, error_count, last_error, created_at, updated_at
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,NULL,NOW(),NOW())
  ON CONFLICT (company_id, invoice_no) DO NOTHING
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