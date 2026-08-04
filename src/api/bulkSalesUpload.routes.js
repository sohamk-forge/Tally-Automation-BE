import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

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

/* =========================================
   BULK SALES UPLOAD

   verifySession() runs BEFORE multer on purpose: an unauthenticated request
   is rejected before a file is ever written to disk, so there is no orphan
   temp file to clean up.

   userId comes from the session, never from req.body. Accepting it from the
   client would let anyone route work to another user's connector — which is
   exactly the failure this whole ownership chain exists to prevent.

   The identity has to survive two queue hops to be useful:

     upload (userId from session)
       -> bulkSalesQueue { ..., userId }
       -> bulkSales.worker: extracts the Excel, inserts rows
       -> salesQueue { salesId, userId }          <- worker must pass it on
       -> pushSalesInvoice.worker
       -> resolveConnectorForCompany(companyId, userId)
       -> connector_jobs.user_id = the uploader's own live connector

   Dropping userId at any hop puts the invoices in whichever connector the
   fallback happens to pick — i.e. someone else's Tally.
========================================= */

router.post(
  "/bulk-sales-upload",
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
          originalFilename: req.file.originalname,

          // Authenticated user who requested this bulk push. bulkSales.worker
          // MUST forward this onto every salesQueue job it creates, or the
          // individual invoices lose their owner and get routed by fallback.
          userId
        },
        {
          ...BULK_SALES_JOB_OPTIONS,
          jobId: getBulkSalesJobId(batchId)
        }
      );

      console.log("Bulk sales upload queued", {
        batchId,
        companyId,
        userId,
        filename: req.file.originalname
      });

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