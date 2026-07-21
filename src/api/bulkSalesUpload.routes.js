import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  bulkSalesQueue,
  BULK_SALES_JOB_OPTIONS,
  getBulkSalesJobId
} from "../queues/bulkSales.queue.js";

const router = express.Router();

// Ensure uploads directory exists
const UPLOAD_DIR = "uploads/bulk-sales";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB max
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
      "application/vnd.ms-excel"                                            // .xls
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
    }
  }
});

router.post(
  "/bulk-sales-upload",
  upload.single("file"),
  async (req, res) => {

    try {

      const company = req.body.company?.trim();

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
        `SELECT id
         FROM ${DB_SCHEMA}.companies
         WHERE TRIM(name) = TRIM($1)
         LIMIT 1`,
        [company]
      );

      if (!companyResult.rows.length) {
        // Clean up uploaded file if company not found
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          status: "error",
          message: `Company not found: ${company}`
        });
      }

      const companyId = companyResult.rows[0].id;
      const batchId   = Date.now();

      await bulkSalesQueue.add(
        "bulk-sales",
        {
          batchId,
          company,
          companyId,
          filePath:         req.file.path,
          originalFilename: req.file.originalname
        },
        {
          ...BULK_SALES_JOB_OPTIONS,
          jobId: getBulkSalesJobId(batchId)
        }
      );

      return res.status(200).json({
        status:   "success",
        message:  "Bulk sales upload queued successfully",
        batchId,                          // return so client can poll status
        filename: req.file.originalname
      });

    } catch (error) {

      // Clean up uploaded file on unexpected error
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      console.error("Bulk sales upload error:", error);

      return res.status(500).json({
        status:  "error",
        message: error.message
      });

    }

  }
);

export default router;