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

    const { company, filePath, userId } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for bulk sales job ${job.id}`);
    }

    console.log(`Reading Sales Excel : ${filePath}`, { userId });

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

    const companyDetailsResult = await pool.query(
      `SELECT gstin FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
      [companyId]
    );

    const companyGstin = (companyDetailsResult.rows[0]?.gstin || "").trim();
    const companyStateCode = companyGstin.substring(0, 2);

    if (!companyStateCode) {
      throw new Error(
        `Cannot determine this company's own GST state (company_id ${companyId}) — run /api/sync/company-details first.`
      );
    }

    console.log(`Company GST state resolved: ${companyStateCode} (from GSTIN ${companyGstin})`);

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

      const rawGstPercent = getValue(row, [
        "GST Rate(%) 0, 3, 5, 12, 18, 28",
        "GST Rate(%) 0, 5, 12, 18, 28",
        "GST Rate(%) 0,3,5,12,18,28",
        "GST Rate(%) 0,5,12,18,28",
        "GST Rate (%) 0,3,5,12,18,28",
        "GST %",
        "GST Percentage",
        "GST Rate",
        "Gst %",
        "GST"
      ]);

      const lineGstPercent = safeNumber(rawGstPercent);

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
          ])),
          // Own GST rate for this line — falls back to the invoice's rate
          // (first row seen) only if this row didn't specify one, so
          // mixed-rate line items on the same invoice are computed correctly.
          gst_percent: gstPercent || invoices[invoiceNo].gst_percent
        });
      }
    }

    Object.values(invoices).forEach(invoice => {

      // A GSTIN state prefix only counts as interstate when it's an actual
      // 2-digit numeric code. Placeholder text like "NA" (or a blank GSTIN)
      // means "no registered GSTIN" — i.e. a local/unregistered sale — not
      // an interstate one, so it must fall into the CGST+SGST branch below.
      const rawStateCode = String(invoice.customer_gstin || "")
        .trim()
        .substring(0, 2);

      const stateCode = /^\d{2}$/.test(rawStateCode) ? rawStateCode : "";

      // GST is calculated per LINE ITEM (each rounded to 2dp) and the
      // per-line figures are summed to get the invoice's CGST/SGST/IGST —
      // NOT calculated once on the invoice's combined taxable_amount.
      // This matches how the source Excel's own totals are built, and is
      // an intentional choice (confirmed) even though it means our output
      // no longer matches a voucher entered against the combined total,
      // e.g. a 2-line invoice can land 1-2 paise higher than the
      // combined-total method due to rounding twice instead of once.
      let cgstSum = 0;
      let sgstSum = 0;
      let igstSum = 0;

      const items = invoice.line_items.length ? invoice.line_items : [{
        amount: invoice.taxable_amount,
        gst_percent: invoice.gst_percent
      }];

      for (const item of items) {
        const lineTaxable = item.amount || 0;
        const lineGstPercent = item.gst_percent || invoice.gst_percent;

        if (stateCode && stateCode !== "27") {
          igstSum += Number(((lineTaxable * lineGstPercent) / 100).toFixed(2));
        } else {
          const halfRate = lineGstPercent / 2;
          const halfRaw = (lineTaxable * halfRate) / 100;
          const halfRounded = Number(halfRaw.toFixed(2));

          // Diagnostic only — does not change the amount pushed. Rounding
          // each half independently (what we do, "split") and rounding the
          // full line GST once then splitting it ("once") can land a paisa
          // apart. We've confirmed against Eicher's own verified GST report
          // that which one is "correct" is NOT predictable from taxable
          // amount, rate, customer type, or quantity — the identical
          // taxable+rate combination (₹703.39 @ 18%) is verified-correct as
          // ₹126.61 on one invoice and ₹126.62 on another. So this can't be
          // auto-corrected; flagged here for manual cross-check against the
          // OEM/GST portal report instead.
          const splitLineTotal = Number((halfRounded * 2).toFixed(2));
          const onceLineTotal = Number(((lineTaxable * lineGstPercent) / 100).toFixed(2));

          if (splitLineTotal !== onceLineTotal) {
            console.log("⚠️ GST ROUNDING BOUNDARY — verify against OEM/GST portal report:", {
              invoice: invoice.invoice_no,
              item: item.item_name,
              line_taxable: lineTaxable,
              gst_percent: lineGstPercent,
              our_line_total_if_split: splitLineTotal,
              our_line_total_if_rounded_once: onceLineTotal
            });
          }

          cgstSum += halfRounded;
          sgstSum += halfRounded;
        }
      }

      invoice.cgst_amount = Number(cgstSum.toFixed(2));
      invoice.sgst_amount = Number(sgstSum.toFixed(2));
      invoice.igst_amount = Number(igstSum.toFixed(2));

      // Step 4: Subtract TDS
      const baseTotal = Number((
        invoice.taxable_amount +
        invoice.cgst_amount +
        invoice.sgst_amount +
        invoice.igst_amount -
        invoice.tds_amount
      ).toFixed(2));

      if (invoice.has_excel_total) {

        const derivedRoundOff = Number(
          (invoice.excel_total - baseTotal).toFixed(2)
        );

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
        invoice.grand_total = Number(invoice.excel_total.toFixed(2));

      } else if (invoice.has_round_off) {

        invoice.grand_total = Number((baseTotal + invoice.round_off).toFixed(2));

      } else {

        invoice.round_off = 0;
        invoice.grand_total = baseTotal;
      }

      console.log("FINAL GST CHECK", {
        invoice: invoice.invoice_no,
        customer_state: customerStateCode,
        company_state: companyStateCode,
        is_intrastate: isIntraState,
        taxable: invoice.taxable_amount,
        gst_percent: invoice.gst_percent,
        gst: Number((invoice.cgst_amount + invoice.sgst_amount + invoice.igst_amount).toFixed(2)),
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