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

      // Check if stock item already exists
      const existingItem = await pool.query(
        `
        SELECT id
        FROM app_test.push_stock_item
        WHERE company_id = $1
          AND TRIM(item_name) = TRIM($2)
        LIMIT 1
        `,
        [companyId, data.item_name?.trim()]
      );

      let stockItemRecord;

      if (existingItem.rows.length > 0) {

        console.log(`Updating existing stock item: ${data.item_name}`);

        const updateResult = await pool.query(
          `
          UPDATE app_test.push_stock_item
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
          RETURNING *
          `,
          [
            data.company?.trim(),
            data.alias_name || "",
            data.unit?.trim(),
            data.description || "",
            data.hsn_code || "",
            data.cgst_rate || 0,
            data.sgst_rate || 0,
            data.igst_rate || 0,
            gstApplicable,
            data.parent_group || "",
            Number(data.opening_quantity || 0),
            Number(data.opening_rate || 0),
            Number(data.opening_value || 0),
            existingItem.rows[0].id
          ]
        );

        stockItemRecord = updateResult.rows[0];
        console.log("Updated Parent Group:", stockItemRecord.parent_group);

      } else {

        console.log(`Creating new stock item: ${data.item_name}`);

        const insertResult = await pool.query(
          `
          INSERT INTO app_test.push_stock_item (
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
          RETURNING *
          `,
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
            Number(data.opening_quantity || 0),
            Number(data.opening_rate || 0),
            Number(data.opening_value || 0)
          ]
        );

        stockItemRecord = insertResult.rows[0];
        console.log("Saved Parent Group:", stockItemRecord.parent_group);
      }

      console.log(`Stock item ${existingItem.rows.length > 0 ? 'updated' : 'created'}: ${data.item_name}`);

      // Queue Job
      await stockItemQueue.add(
        "push-stock-item",
        { stockItemId: stockItemRecord.id },
        {
          ...STOCK_ITEM_JOB_OPTIONS,
          jobId: getStockItemJobId(stockItemRecord.id)
        }
      );

      return res.status(200).json({
        status: "success",
        message: existingItem.rows.length > 0
          ? "Stock item updated and queued successfully"
          : "Stock item created and queued successfully",
        data: stockItemRecord
      });

    } catch (err) {
      console.log("ERROR:", err.message);
      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  });


  // Optional: Get status by specific item name
  router.get("/push/stock-item/status/:companyId", async (req, res) => {
    try {
      console.log("STATUS API HIT");

      const { companyId } = req.params;

      const result = await pool.query(
        `
        SELECT *
        FROM app_test.push_stock_item
        WHERE company_id = $1
        ORDER BY id DESC
        `,
        [companyId]
      );

      return res.status(200).json({
        status: "success",
        count: result.rowCount,
        data: result.rows
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  });

  export default router;