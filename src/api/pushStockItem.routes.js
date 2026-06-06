import express from "express";
import pool from "../db/index.js";
import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS,
  getStockItemJobId
} from "../queues/stockItem.queue.js";

const router = express.Router();

router.post("/push/stock-item", async (req, res) => {

  try {
    const data = req.body;
    console.log("Parent Group Received:", data.parent_group);

    console.log("====================================");
    console.log("PUSH STOCK ITEM API HIT");
    console.log("====================================");
    console.log(JSON.stringify(data, null, 2));

    // Validation 1: Required fields
    if (!data.company || !data.item_name || !data.unit) {
      return res.status(400).json({
        status: "error",
        message: "company, item_name and unit are required"
      });
    }

    // Validation 2: GST Applicable value
    const gstApplicable = data.gst_applicable || "Not Applicable";

    if (!["Applicable", "Not Applicable"].includes(gstApplicable)) {
      return res.status(400).json({
        status: "error",
        message: "gst_applicable must be 'Applicable' or 'Not Applicable'"
      });
    }

    // Validation 3: Company exists
    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies WHERE TRIM(name) = TRIM($1)`,
      [data.company]
    );

    const companyId = companyResult.rows[0]?.id || null;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: `Company '${data.company}' not found`
      });
    }

    // Validation 4: Duplicate check
    const duplicateResult = await pool.query(
      `SELECT id FROM app_test.push_stock_item
       WHERE TRIM(company_name) = TRIM($1)
         AND TRIM(item_name) = TRIM($2)
         AND status IN ('pending', 'success')`,
      [data.company, data.item_name]
    );

    if (duplicateResult.rows.length) {
      return res.status(400).json({
        status: "error",
        message: "Stock item already queued or synced"
      });
    }

    // Insert record
    const insertResult = await pool.query(
      `INSERT INTO app_test.push_stock_item (
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
        status,
        created_at,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        NOW(),
        NOW()
      )
      RETURNING *`,
      [
        companyId,
        data.company?.trim(),
        data.item_name?.trim(),
        data.alias_name || "",
        data.unit?.trim(),
        data.description || "",
        data.hsn_code || "",
        data.cgst_rate || 0,
        data.sgst_rate || 0,
        data.igst_rate || 0,
        gstApplicable,
        data.parent_group || "",
        "pending"
      ]
    );

    console.log(
      "Saved Parent Group:",
      insertResult.rows[0].parent_group
    );

    console.log(
      `Stock item queued: ${data.item_name}`
    );

    await stockItemQueue.add(
      "push-stock-item",
      { stockItemId: insertResult.rows[0].id },
      {
        ...STOCK_ITEM_JOB_OPTIONS,
        jobId: getStockItemJobId(insertResult.rows[0].id)
      }
    );

    return res.status(200).json({
      status: "success",
      message: "Stock item queued successfully",
      data: insertResult.rows[0]
    });

  } catch (err) {
    console.log("ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;
