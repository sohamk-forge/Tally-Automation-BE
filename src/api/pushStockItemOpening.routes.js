import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess } from "../utils/companyAccess.js";
import { alterStockItemQueue, ALTER_STOCK_ITEM_JOB_OPTIONS, getAlterStockItemJobId } from "../queues/alterStockItem.queue.js";

const router = express.Router();

router.post("/push-stock-item-opening", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const data = req.body;

    if (!data.company?.trim() || !data.item_name?.trim()) {
      return res.status(400).json({
        status: "error",
        message: "company and item_name are required"
      });
    }

    console.log(`🔍 Looking up company: ${data.company.trim()}`);

    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies
       WHERE name = $1 LIMIT 1`,
      [data.company.trim()]
    );

    if (!companyResult.rows.length) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${data.company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    console.log(`✅ User ${userId} has access to company ${companyId}`);

    const stockItemResult = await pool.query(
      `SELECT id, item_name FROM app_test.push_stock_item
       WHERE company_id = $1
         AND TRIM(item_name) = TRIM($2)
         AND status = 'success'
       LIMIT 1`,
      [companyId, data.item_name?.trim()]
    );

    const stockItem = stockItemResult.rows[0];

    if (!stockItem) {
      return res.status(404).json({
        status: "error",
        message: "Stock item not found or not synced"
      });
    }

    console.log(`📝 Updating opening stock for: ${data.item_name}`);

    const updateResult = await pool.query(
      `UPDATE app_test.push_stock_item
       SET
         opening_quantity = $1,
         opening_rate = $2,
         opening_value = $3,
         updated_at = NOW()
       WHERE id = $4
       RETURNING
         id,
         item_name,
         opening_quantity,
         opening_rate,
         opening_value`,
      [
        data.opening_quantity || 0,
        data.opening_rate || 0,
        data.opening_value || 0,
        stockItem.id
      ]
    );

    const updatedRecord = updateResult.rows[0];
    console.log(`✅ Opening stock updated: ${updatedRecord.item_name}`);

    const jobId = getAlterStockItemJobId(stockItem.id);
    
    await alterStockItemQueue.add(
      "push-alter-stock-item",
      {
        stockItemId: stockItem.id,
        userId
      },
      {
        ...ALTER_STOCK_ITEM_JOB_OPTIONS,
        jobId
      }
    );

    console.log(`📤 Opening stock job queued: ${data.item_name}`);

    return res.status(200).json({
      status: "success",
      message: "Opening stock queued successfully",
      company_id: companyId,
      data: updatedRecord
    });

  } catch (error) {
    console.error("❌ PUSH STOCK ITEM OPENING ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

export default router;