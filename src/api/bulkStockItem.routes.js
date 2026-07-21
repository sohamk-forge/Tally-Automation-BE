import express from "express";
import multer from "multer";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  bulkStockItemQueue,
  BULK_STOCK_ITEM_JOB_OPTIONS,
  getBulkStockItemJobId
} from "../queues/bulkStockItem.queue.js";

const router = express.Router();

const upload = multer({
  dest: "uploads/"
});

router.post(
  "/bulk-stock-upload",
  upload.single("file"),
  async (req, res) => {
    try {

      const { company } = req.body;

      if (!company) {
        return res.status(400).json({
          status: "error",
          message: "company is required"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "Excel file is required"
        });
      }

      const companyResult = await pool.query(
        `
        SELECT id
        FROM ${DB_SCHEMA}.companies
        WHERE TRIM(name)=TRIM($1)
        `,
        [company]
      );

      const companyId =
        companyResult.rows[0]?.id;

      if (!companyId) {
        return res.status(400).json({
          status: "error",
          message: "Company not found"
        });
      }

      const batchId = Date.now();

      await bulkStockItemQueue.add(
        "bulk-stock-item",
        {
          batchId,
          company,
          companyId,
          filePath: req.file.path
        },
        {
          ...BULK_STOCK_ITEM_JOB_OPTIONS,
          jobId:
            getBulkStockItemJobId(batchId)
        }
      );

      return res.json({
        status: "success",
        message:
          "Bulk upload queued successfully"
      });

    } catch (error) {

      return res.status(500).json({
        status: "error",
        message: error.message
      });

    }
  }
);

export default router;