import express from "express";
import multer from "multer";
import fs from "fs";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

import { DB_SCHEMA } from "../config/db.js";
import {
  bulkStockItemQueue,
  BULK_STOCK_ITEM_JOB_OPTIONS,
  getBulkStockItemJobId
} from "../queues/bulkStockItem.queue.js";

const router = express.Router();

const UPLOAD_DIR = "uploads/bulk-stock-item";
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

/* =========================================
   BULK STOCK ITEM UPLOAD

   Mirrors bulk-sales-upload: verifySession() runs before multer so an
   unauthenticated request is rejected before a file is written to disk,
   and userId comes from the session (never req.body) so bulkStockItem.worker
   can route each item to the uploader's own connector instead of falling
   back to whichever connector for the company happens to be live.
========================================= */

router.post(
  "/bulk-stock-upload",
  verifySession(),
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = await getLocalUserId(req.session.getUserId());

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

      const companyId =
        companyResult.rows[0]?.id;

      if (!companyId) {
        fs.unlink(req.file.path, () => {});

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
          filePath: req.file.path,

          // Authenticated user who requested this bulk push. bulkStockItem.worker
          // MUST forward this onto every stockItemQueue job it creates, or the
          // individual items lose their owner and get routed by fallback.
          userId
        },
        {
          ...BULK_STOCK_ITEM_JOB_OPTIONS,
          jobId:
            getBulkStockItemJobId(batchId)
        }
      );

      console.log("Bulk stock item upload queued", {
        batchId,
        companyId,
        userId,
        filename: req.file.originalname
      });

      return res.json({
        status: "success",
        message:
          "Bulk upload queued successfully",
        batchId
      });

    } catch (error) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }

      return res.status(500).json({
        status: "error",
        message: error.message
      });

    }
  }
);

export default router;
