import { DB_SCHEMA } from "../config/db.js";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import XLSX from "xlsx";

import pool from "../db/index.js";

import {
  BULK_STOCK_ITEM_QUEUE_NAME
} from "../queues/bulkStockItem.queue.js";

import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS
} from "../queues/stockItem.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Helper to get value from multiple possible header names (headers are
// normalized to lowercase before this is called).
function getValue(row, possibleKeys) {
  for (const key of possibleKeys) {
    const target = String(key).toLowerCase();
    if (row[target] !== undefined && String(row[target]).trim() !== "") {
      return row[target];
    }
  }
  return "";
}

const worker = new Worker(
  BULK_STOCK_ITEM_QUEUE_NAME,

  async (job) => {

    // userId comes from the upload route's session and must be forwarded onto
    // every stockItemQueue job below. Without it, pushStockItem.worker calls
    // resolveConnectorForCompany() with no acting user, the acting-user-first
    // branch is skipped, and every item from this upload routes by fallback —
    // i.e. into whichever connector for that company happens to be live,
    // which may be someone else's Tally entirely.
    const { company, companyId, filePath, userId } = job.data;

    if (!userId) {
      throw new Error(`Missing userId for bulk stock item job ${job.id}`);
    }

    console.log(`Reading Stock Item Excel : ${filePath}`, { userId });

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

    let successCount = 0;
    let failCount = 0;

    for (const row of rows) {
      try {
        const itemName = String(getValue(row, [
          "item name",
          "item",
          "stock item name",
          "particulars"
        ])).trim();

        if (!itemName) {
          continue;
        }

        const unitName = String(getValue(row, [
          "unit",
          "unit name",
          "uom",
          "unit of measure"
        ])).trim();

        const gstApplicableRaw = String(getValue(row, [
          "gst applicable",
          "gst applicability"
        ])).trim();

        const gstApplicable =
          ["applicable", "not applicable"].includes(gstApplicableRaw.toLowerCase())
            ? (gstApplicableRaw.toLowerCase() === "applicable" ? "Applicable" : "Not Applicable")
            : "Applicable";

        // The sheet gives one combined "GST RATE" (e.g. 18%), not separate
        // CGST/SGST/IGST columns. pushXmlBuilder always writes all three rate
        // blocks regardless of transaction type (see getStockItemCreateXML),
        // so we split the standard way: CGST = SGST = half the rate, IGST =
        // the full rate. Tally applies whichever pair is relevant per voucher.
        const gstRate = safeNumber(getValue(row, [
          "gst rate",
          "gst rate details",
          "gst %",
          "gst percentage"
        ]));

        const itemData = {
          item_name: itemName,
          alias_name: String(getValue(row, ["alias", "alias name"])).trim(),
          unit_name: unitName,
          description: String(getValue(row, ["description"])).trim(),
          hsn_code: String(getValue(row, ["hsn code", "hsn", "hsn/sac details", "hsn/sac"])).trim(),
          cgst_rate: Number((gstRate / 2).toFixed(2)),
          sgst_rate: Number((gstRate / 2).toFixed(2)),
          igst_rate: gstRate,
          gst_applicable: gstApplicable,
          parent_group: String(getValue(row, ["parent group", "group", "stock group", "group/category"])).trim(),
          opening_quantity: safeNumber(getValue(row, ["opening quantity", "opening qty", "quantity", "qty"])),
          opening_rate: safeNumber(getValue(row, ["opening rate", "rate"])),
          opening_value: safeNumber(getValue(row, ["opening value", "opening amount", "amount"]))
        };

        if (!unitName) {
          console.log(`⚠️ Skipping item ${itemName} - unit is required`);
          failCount++;
          continue;
        }

        // No unique DB constraint on (company_id, item_name), so mirror the
        // single-item push route: look the row up first, then update or
        // insert, instead of relying on ON CONFLICT.
        const existing = await pool.query(
          `
          SELECT id
          FROM ${DB_SCHEMA}.push_stock_item
          WHERE company_id = $1
            AND TRIM(item_name) = TRIM($2)
          LIMIT 1
          `,
          [companyId, itemData.item_name]
        );

        let stockItemId;

        if (existing.rows.length > 0) {
          stockItemId = existing.rows[0].id;

          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.push_stock_item
            SET
              company_name = $1,
              alias_name = $2,
              unit_name = $3,
              description = $4,
              hsn_code = $5,
              cgst_rate = $6,
              sgst_rate = $7,
              igst_rate = $8,
              gst_applicable = $9,
              parent_group = $10,
              opening_quantity = $11,
              opening_rate = $12,
              opening_value = $13,
              status = 'pending',
              error_count = 0,
              last_error = NULL,
              updated_at = NOW()
            WHERE id = $14
            `,
            [
              company,
              itemData.alias_name,
              itemData.unit_name,
              itemData.description,
              itemData.hsn_code,
              itemData.cgst_rate,
              itemData.sgst_rate,
              itemData.igst_rate,
              itemData.gst_applicable,
              itemData.parent_group,
              itemData.opening_quantity,
              itemData.opening_rate,
              itemData.opening_value,
              stockItemId
            ]
          );
        } else {
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
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
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
              itemData.item_name,
              itemData.alias_name,
              itemData.unit_name,
              itemData.description,
              itemData.hsn_code,
              itemData.cgst_rate,
              itemData.sgst_rate,
              itemData.igst_rate,
              itemData.gst_applicable,
              itemData.parent_group,
              itemData.opening_quantity,
              itemData.opening_rate,
              itemData.opening_value
            ]
          );

          stockItemId = insertResult.rows[0].id;
        }

        // The job id MUST be unique per push — a fixed id per item would let
        // BullMQ silently ignore add() on re-upload (see bulkSales.worker.js
        // for the incident this pattern was fixed for).
        await stockItemQueue.add(
          "push-stock-item",
          {
            stockItemId,
            userId
          },
          {
            ...STOCK_ITEM_JOB_OPTIONS,
            jobId: `stock-item-${stockItemId}-${Date.now()}`
          }
        );

        console.log(`✅ Stock Item Queued : ${stockItemId} (${itemName}, User: ${userId})`);
        successCount++;

      } catch (error) {
        console.error(`❌ Stock Item Insert Failed:`, error.message);
        failCount++;
      }
    }

    console.log(`📊 Bulk Stock Item Done -> Success:${successCount} Failed:${failCount}`);

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
  console.log(`✅ Bulk Stock Item Job Completed : ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`❌ Bulk Stock Item Job Failed : ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("❌ Bulk Stock Item Worker Error:", error.message);
});

console.log("🚀 Bulk Stock Item Worker Started");

export default worker;
