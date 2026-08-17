import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

import {
  stockItemQueue,
  STOCK_ITEM_JOB_OPTIONS,
  getStockItemJobId
} from "../queues/stockItem.queue.js";

import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

const router = express.Router();


// ============================================================
// PUSH STOCK ITEM
// ============================================================

router.post(
  "/push-stock-item",
  verifySession(),
  async (req, res) => {
    try {

      // ========================================================
      // 1. GET LOGGED-IN USER
      // ========================================================

      const userId = await getLocalUserId(
        req.session.getUserId()
      );

      if (!userId) {
        return res.status(404).json({
          status: "error",
          message: "No profile found for this account"
        });
      }


      // ========================================================
      // 2. REQUEST DATA
      // ========================================================

      const data = req.body;

      console.log("====================================");
      console.log("PUSH STOCK ITEM API HIT");
      console.log("====================================");

      console.log(
        JSON.stringify(data, null, 2)
      );


      // ========================================================
      // 3. VALIDATE REQUIRED FIELDS
      // ========================================================

      if (
        !data.company_id ||
        !data.company ||
        !data.item_name ||
        !data.unit
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "company_id, company, item_name and unit are required"
        });
      }


      // ========================================================
      // 4. VALIDATE COMPANY ID
      // ========================================================

      const companyId = Number(
        data.company_id
      );

      if (
        !Number.isInteger(companyId) ||
        companyId <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message: "Invalid company_id"
        });
      }


      console.log("========== PUSH STOCK ITEM ==========");
      console.log("Request userId:", userId);
      console.log("Request companyId:", companyId);
      console.log("Request company:", data.company);
      console.log("Stock Item:", data.item_name);


      // ========================================================
      // 5. GET EXACT COMPANY BY ID
      // ========================================================

      const companyResult =
        await pool.query(
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


      if (
        companyResult.rows.length === 0
      ) {
        return res.status(404).json({
          status: "error",
          message:
            `Company not found: ${companyId}`
        });
      }


      const company =
        companyResult.rows[0];


      console.log(
        "✅ COMPANY SELECTED:",
        {
          companyId: company.id,
          companyName: company.name,
          userId
        }
      );


      // ========================================================
      // 6. GST APPLICABLE VALIDATION
      // ========================================================

      const gstApplicable =
        data.gst_applicable ||
        "Not Applicable";


      if (
        ![
          "Applicable",
          "Not Applicable"
        ].includes(gstApplicable)
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "gst_applicable must be 'Applicable' or 'Not Applicable'"
        });
      }


      // ========================================================
      // 7. CHECK EXISTING STOCK ITEM
      //    IMPORTANT: COMPANY ID IS USED
      // ========================================================

      const existingItem =
        await pool.query(
          `
          SELECT id
          FROM ${DB_SCHEMA}.push_stock_item
          WHERE company_id = $1
            AND LOWER(TRIM(item_name))
                = LOWER(TRIM($2))
          LIMIT 1
          `,
          [
            companyId,
            data.item_name?.trim()
          ]
        );


      let stockItemRecord;


      // ========================================================
      // 8. UPDATE EXISTING STOCK ITEM
      // ========================================================

      if (
        existingItem.rows.length > 0
      ) {

        console.log(
          `Updating existing stock item: ${data.item_name}`
        );


        const updateResult =
          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.push_stock_item
            SET
              company_id = $1,
              company_name = $2,
              alias_name = $3,
              unit_name = $4,
              description = $5,
              hsn_code = $6,
              cgst_rate = $7,
              sgst_rate = $8,
              igst_rate = $9,
              gst_applicable = $10,
              parent_group = $11,
              opening_quantity = $12,
              opening_rate = $13,
              opening_value = $14,
              status = 'pending',
              error_count = 0,
              last_error = NULL,
              updated_at = NOW()
            WHERE id = $15
            RETURNING *
            `,
            [
              companyId,
              company.name,
              data.alias_name || "",
              data.unit?.trim(),
              data.description || "",
              data.hsn_code || "",
              data.cgst_rate || 0,
              data.sgst_rate || 0,
              data.igst_rate || 0,
              gstApplicable,
              data.parent_group || "",
              Number(
                data.opening_quantity || 0
              ),
              Number(
                data.opening_rate || 0
              ),
              Number(
                data.opening_value || 0
              ),
              existingItem.rows[0].id
            ]
          );


        stockItemRecord =
          updateResult.rows[0];


        console.log(
          "Updated Stock Item:",
          stockItemRecord
        );

      }


      // ========================================================
      // 9. CREATE NEW STOCK ITEM
      // ========================================================

      else {

        console.log(
          `Creating new stock item: ${data.item_name}`
        );


        const insertResult =
          await pool.query(
            `
            INSERT INTO ${DB_SCHEMA}.push_stock_item
            (
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
            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              $12,
              $13,
              $14,
              $15,
              'pending',
              NOW(),
              NOW()
            )
            RETURNING *
            `,
            [
              companyId,
              company.name,
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
              Number(
                data.opening_quantity || 0
              ),
              Number(
                data.opening_rate || 0
              ),
              Number(
                data.opening_value || 0
              )
            ]
          );


        stockItemRecord =
          insertResult.rows[0];


        console.log(
          "Saved Stock Item:",
          stockItemRecord
        );
      }


      // ========================================================
      // 10. QUEUE JOB
      // ========================================================

      console.log(
        `Stock item ${
          existingItem.rows.length > 0
            ? "updated"
            : "created"
        }: ${data.item_name}`
      );


      const jobId =
        getStockItemJobId(
          stockItemRecord.id
        );


      const existingJob =
        await stockItemQueue.getJob(
          jobId
        );


      if (existingJob) {

        const state =
          await existingJob.getState();


        if (
          [
            "completed",
            "failed"
          ].includes(state)
        ) {

          await existingJob.remove();

        }

        else if (
          [
            "active",
            "waiting",
            "delayed"
          ].includes(state)
        ) {

          return res.status(200).json({
            status: "success",
            message:
              "Push already in progress for this item",
            data: stockItemRecord
          });
        }
      }


      // ========================================================
      // 11. ADD JOB
      //    IMPORTANT: SEND COMPANY ID
      // ========================================================

      await stockItemQueue.add(
        "push-stock-item",
        {
          stockItemId:
            stockItemRecord.id,

          userId,

          companyId
        },
        {
          ...STOCK_ITEM_JOB_OPTIONS,
          jobId
        }
      );


      console.log(
        "📥 STOCK ITEM QUEUED:",
        {
          stockItemId:
            stockItemRecord.id,
          userId,
          companyId,
          jobId
        }
      );


      // ========================================================
      // 12. RESPONSE
      // ========================================================

      return res.status(200).json({
        status: "success",

        message:
          existingItem.rows.length > 0
            ? "Stock item updated and queued successfully"
            : "Stock item created and queued successfully",

        data: stockItemRecord,

        userId,

        companyId,

        jobId
      });

    }

    catch (err) {

      console.error(
        "❌ PUSH STOCK ITEM ERROR:",
        err
      );


      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  }
);


// ============================================================
// STOCK ITEM STATUS
// ============================================================

router.get(
  "/push/stock-item/status/:companyId",
  verifySession(),
  async (req, res) => {

    try {

      console.log(
        "STATUS API HIT"
      );


      const {
        companyId
      } = req.params;


      const {
        status,
        item_name,
        error_only
      } = req.query;


      let query = `
        SELECT
          id,
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
          error_count,
          last_error,
          tally_response,
          created_at,
          updated_at
        FROM ${DB_SCHEMA}.push_stock_item
        WHERE company_id = $1
      `;


      const params = [
        companyId
      ];


      if (status) {

        query += `
          AND status = $${params.length + 1}
        `;

        params.push(status);
      }


      if (item_name) {

        query += `
          AND LOWER(TRIM(item_name))
              =
              LOWER(TRIM($${params.length + 1}))
        `;

        params.push(item_name);
      }


      if (
        error_only === "true"
      ) {

        query += `
          AND error_count > 0
        `;
      }


      query += `
        ORDER BY id DESC
      `;


      const result =
        await pool.query(
          query,
          params
        );


      const failedItems =
        result.rows.filter(
          r => r.status === "failed"
        );


      const pendingItems =
        result.rows.filter(
          r => r.status === "pending"
        );


      const successItems =
        result.rows.filter(
          r => r.status === "success"
        );


      return res.status(200).json({

        status: "success",

        count:
          result.rowCount,

        summary: {
          total:
            result.rowCount,

          success:
            successItems.length,

          pending:
            pendingItems.length,

          failed:
            failedItems.length
        },

        data:
          result.rows,

        failedItems,

        pendingItems,

        successItems

      });

    }

    catch (err) {

      console.error(
        "❌ STOCK ITEM STATUS ERROR:",
        err
      );


      return res.status(500).json({
        status: "error",
        message: err.message
      });
    }
  }
);


export default router;