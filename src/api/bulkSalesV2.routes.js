import express from "express";
import multer from "multer";
import fs from "fs";

import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  bulkSalesQueueV2,
  BULK_SALES_V2_JOB_OPTIONS,
  getBulkSalesV2JobId
} from "../queues/bulkSalesV2.queue.js";

const router = express.Router();

const UPLOAD_DIR = "uploads/bulk-sales-v2";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
    }
  }
});

// Accepts any of the 3 known formats — Spare Sales, Spare + Labour, or
// Warranty GST reports. The worker auto-detects which one this file is
// from its headers, so the same endpoint handles all three.
router.post(
  "/bulk-sales-upload-v2",
  verifySession(),
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = await getLocalUserId(
        req.session.getUserId()
      );

      if (!userId) {
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }

        return res.status(404).json({
          status: "error",
          message: "No profile found for this account"
        });
      }

      const company = req.body.company?.trim();

      if (!company) {
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }

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

      // Scoped to this acting user's own pairing, not a bare global name
      // match — see the identical fix + rationale in salesInvoices.routes.js.
      const companyResult = await pool.query(
        `
        SELECT c.id
        FROM ${DB_SCHEMA}.companies c
        JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
        WHERE cpt.user_id = $1
          AND cpt.is_used = TRUE
          AND lower(trim(c.name)) = lower(trim($2))
        LIMIT 1
        `,
        [userId, company]
      );

      if (!companyResult.rows.length) {
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          status: "error",
          message: `Company not found: ${company}`
        });
      }

      const companyId = companyResult.rows[0].id;
      const batchId = Date.now();

      const job = await bulkSalesQueueV2.add(
        "bulk-sales-v2",
        {
          batchId,
          company,
          companyId,
          filePath: req.file.path,
          originalFilename: req.file.originalname,
          userId
        },
        {
          ...BULK_SALES_V2_JOB_OPTIONS,
          jobId: getBulkSalesV2JobId(batchId)
        }
      );

      console.log("Bulk Sales V2 upload queued", {
        batchId,
        companyId,
        userId,
        filename: req.file.originalname
      });

      return res.status(200).json({
        status: "success",
        message: "Bulk Sales V2 upload queued successfully",
        batchId,
        jobId: job.id,
        filename: req.file.originalname
      });

    } catch (error) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      console.error(
        "Bulk Sales V2 upload error:",
        error
      );

      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

export default router;