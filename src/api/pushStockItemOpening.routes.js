import { DB_SCHEMA } from "../config/db.js";
import express from "express";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

import { safeEnqueueAlterStockItem } from "../queues/alterStockItem.queue.js";

const router = express.Router();

router.post(
  "/push/stock-item-opening",
  verifySession(),
  async (req, res) => {

    try {

      const userId = await getLocalUserId(req.session.getUserId());

      if (!userId) {
        return res.status(404).json({
          status: "error",
          message: "No profile found for this account"
        });
      }

      const data = req.body;

      console.log("BODY RECEIVED:");
      console.log(req.body);

      console.log(
        "===================================="
      );
      console.log(
        "PUSH STOCK ITEM OPENING API HIT"
      );
      console.log(
        "===================================="
      );
      console.log(
        JSON.stringify(data, null, 2)
      );

      if (
        !data.company_id ||
        !data.company ||
        !data.item_name
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "company_id, company and item_name are required"
        });
      }

      const companyId = Number(data.company_id);

      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid company_id"
        });
      }

      console.log("========== PUSH STOCK ITEM OPENING ==========");
      console.log("Request userId:", userId);
      console.log("Request companyId:", companyId);
      console.log("Request company:", data.company);
      console.log("Item:", data.item_name);

      // =====================================================
      // GET EXACT COMPANY BY ID
      // =====================================================

      const companyResult = await pool.query(
        `
        SELECT
          id,
          name
        FROM ${DB_SCHEMA}.companies
        WHERE id = $1
        LIMIT 1
        `,
        [companyId]
      );

      if (companyResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: `Company not found: ${companyId}`
        });
      }

      const company = companyResult.rows[0];

      console.log("✅ COMPANY SELECTED:", {
        companyId: company.id,
        companyName: company.name,
        userId
      });

      // =====================================================
      // FIND SYNCED STOCK ITEM BY COMPANY_ID
      // =====================================================

      const stockItemResult =
        await pool.query(
          `
          SELECT id
          FROM ${DB_SCHEMA}.push_stock_item
          WHERE
            company_id = $1
            AND TRIM(item_name) = TRIM($2)
            AND status = 'success'
          `,
          [
            companyId,
            data.item_name
          ]
        );

      const stockItem =
        stockItemResult.rows[0];

      if (!stockItem) {
        return res.status(404).json({
          status: "error",
          message:
            "Stock item not found or not synced"
        });
      }

      const updateResult = await pool.query(
        `
        UPDATE ${DB_SCHEMA}.push_stock_item
        SET
          opening_quantity = $1,
          opening_rate = $2,
          opening_value = $3,
          status = 'pending',
          user_id = $4,
          pending_job_type = 'alter',
          updated_at = NOW()
        WHERE id = $5
        RETURNING
          id,
          item_name,
          opening_quantity,
          opening_rate,
          opening_value
        `,
        [
          data.opening_quantity || 0,
          data.opening_rate || 0,
          data.opening_value || 0,
          userId,
          stockItem.id
        ]
      );

      console.log("UPDATED DB RECORD:");
      console.log(updateResult.rows[0]);

      await safeEnqueueAlterStockItem(stockItem.id, userId);

      console.log(
        `Opening stock queued: ${data.item_name} (User: ${userId})`
      );

      return res.status(200).json({
        status: "success",
        message:
          "Opening stock queued successfully"
      });

    } catch (error) {

      console.error(
        "ERROR:",
        error.message
      );

      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

export default router;