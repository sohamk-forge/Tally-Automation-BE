import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  BULK_STOCK_ITEM_QUEUE_NAME
} from "../queues/bulkStockItem.queue.js";

import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS,
  getStockItemJobId
} from "../queues/stockItem.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// Safe number: returns 0 if NaN/undefined/null
function safeNumber(val) {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

// Always returns positive number
function safePositive(val) {
  const n = Number(val);
  return isNaN(n) ? 0 : Math.abs(n);
}

// ✅ Flip sign: + becomes -, - becomes +
function flipSign(val) {
  const n = Number(val);
  return isNaN(n) ? 0 : -n;
}

// Find column value by partial key match (handles spaces/casing)
function getCol(row, ...candidates) {
  for (const key of Object.keys(row)) {
    const normalized = key.trim().toUpperCase();
    if (candidates.some(c => c.toUpperCase() === normalized)) {
      return String(row[key] ?? "").trim();
    }
  }
  return "";
}

// Find column by keyword match (for headers with slight variations)
function getColFuzzy(row, ...keywords) {
  const key = Object.keys(row).find(k =>
    keywords.every(kw =>
      k.trim().toUpperCase().includes(kw.toUpperCase())
    )
  );
  return key ? String(row[key] ?? "").trim() : "";
}

const worker = new Worker(
  BULK_STOCK_ITEM_QUEUE_NAME,
  async (job) => {
    const { company, companyId, filePath } = job.data;

    console.log(`Reading Excel: ${filePath}`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    // Debug: print exact headers and first row
    if (rows.length > 0) {
      console.log("=== EXACT HEADERS ===");
      for (const key of Object.keys(rows[0])) {
        console.log(`"${key}" → [${[...key].map(c => c.charCodeAt(0)).join(",")}]`);
      }
      console.log("=== FIRST ROW ===");
      console.log(rows[0]);
    }

    console.log(`Rows Found: ${rows.length}`);

    let successCount = 0;
    let failCount = 0;

    for (const row of rows) {

      try {
        const itemName = getColFuzzy(row, "ITEM", "NAME");
        console.log("itemName resolved:", JSON.stringify(itemName));

        const unitName  = getCol(row, "UNIT OF MEASURE", "UNIT", "UOM");
        const hsnCode   = getCol(row, "HSN/SAC DETAILS", "HSN CODE", "HSN_CODE");
        const group     = getCol(row, "GROUP/CATEGORY", "GROUP", "CATEGORY");

        const gstKey = Object.keys(row).find(k =>
          k.trim().toUpperCase().includes("GST") &&
          k.trim().toUpperCase().includes("APPLIC")
        );
        const gstApplicableRaw = gstKey
          ? String(row[gstKey] || "").trim().toUpperCase()
          : "";
        const gstApplicable = gstApplicableRaw === "APPLICABLE"
          ? "Applicable"
          : "Not Applicable";

        // GST split
        const gstRate = safeNumber(getCol(row, "GST RATE", "GSTRATE"));
        const cgst    = gstRate / 2;  // 9
        const sgst    = gstRate / 2;  // 9
        const igst    = gstRate;       // 18 ✅

        // Qty and Rate — always positive
        const openingQty   = safePositive(getCol(row, "QUANTITY RATE", "QUANTITY", "QTY"));
        const openingRate  = safePositive(getCol(row, "RATE", "QUANTITY RATE"));

        // ✅ Value only — flip sign (+ → -, - → +)
        const openingValue = flipSign(getCol(row, "AMOUNT"));

        console.log(`GST → cgst:${cgst} sgst:${sgst} igst:${igst}`);
        console.log(`Opening → qty:${openingQty} rate:${openingRate} value:${openingValue}`);

        // Skip rows with no item name
        if (!itemName) {
          console.warn(`Skipping row — no item name found:`, row);
          failCount++;
          continue;
        }

        const insertResult = await pool.query(
          `
          INSERT INTO ${DB_SCHEMA}.push_stock_item (
            company_id,
            company_name,
            item_name,
            alias_name,
            unit_name,
            description,
            hsn_code,
            cgst_rate,
            sgst_rate,
            igst_rate,
            gst_applicable,
            parent_group,
            opening_quantity,
            opening_rate,
            opening_value,
            status,
            created_at,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,$11,$12,
            $13,$14,$15,
            'pending',
            NOW(),
            NOW()
          )
          RETURNING id
          `,
          [
            companyId,
            company,
            itemName,
            "",           // alias_name — not in Excel
            unitName,
            "",           // description — not in Excel
            hsnCode,
            cgst,         // 9
            sgst,         // 9
            igst,         // 18 ✅
            gstApplicable,
            group,
            openingQty,   // always positive
            openingRate,  // always positive
            openingValue  // ✅ sign flipped only here
          ]
        );

        const stockItemId = insertResult.rows[0].id;

        await stockItemQueue.add(
          "push-stock-item",
          { stockItemId },
          {
            ...STOCK_ITEM_JOB_OPTIONS,
            jobId: getStockItemJobId(stockItemId)
          }
        );

        successCount++;

      } catch (rowError) {
        console.error(`Row insert failed:`, rowError.message, row);
        failCount++;
      }
    }

    console.log(`Bulk upload done — success: ${successCount}, failed: ${failCount}`);

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
  console.log(`Bulk stock item job completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`Bulk stock item job failed: ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("Bulk stock item worker error:", error.message);
});

console.log("Bulk Stock Item Worker Started");

export default worker;