import express from "express";
import multer from "multer";
import fs from "fs";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";
import { bulkSalesQueue, BULK_SALES_JOB_OPTIONS, getBulkSalesJobId } from "../queues/bulkSales.queue.js";

const router = express.Router();

const UPLOAD_DIR = "uploads/bulk-sales";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
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

router.post(
  "/bulk-sales-upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = req.user.id;
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
        `SELECT id FROM app_test.companies
         WHERE TRIM(name) = TRIM($1) LIMIT 1`,
        [company]
      );

      if (!companyResult.rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          status: "error",
          message: `Company not found: ${company}`
        });
      }

      const companyId = companyResult.rows[0].id;

      const hasAccess = await checkCompanyAccess(userId, companyId);
      if (!hasAccess) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({
          status: "error",
          message: "You don't have access to this company"
        });
      }

      const batchId = Date.now();
      await bulkSalesQueue.add(
        "bulk-sales",
        {
          batchId,
          company,
          companyId,
          userId,
          filePath: req.file.path,
          originalFilename: req.file.originalname
        },
        {
          ...BULK_SALES_JOB_OPTIONS,
          jobId: getBulkSalesJobId(batchId)
        }
      );

      return res.status(200).json({
        status: "success",
        message: "Bulk sales upload queued successfully",
        batchId,
        filename: req.file.originalname
      });

    } catch (error) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      console.error("Bulk sales upload error:", error.message);
      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

export default router;