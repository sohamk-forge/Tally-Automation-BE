/**
 * api/companyLogo.routes.js
 * ===========================
 * Upload / remove endpoints for a company's persistent logo.
 * Mounted at "/api/companies" in app.js, so routes here are relative
 * to that (e.g. "/:companyId/logo", not "/companies/:companyId/logo").
 */

import express from "express";
import multer from "multer";
import { normalizeLogoUpload } from "../services/logoConversion.service.js";
import {
  saveCompanyLogo,
  deleteCompanyLogo,
  getCompanyLogoMeta,
} from "../services/companyLogo.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
});

/**
 * POST /api/companies/:companyId/logo
 * multipart/form-data, field name "logo"
 */
router.post("/:companyId/logo", upload.single("logo"), async (req, res) => {
  try {
    const { companyId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No logo file uploaded (expected field 'logo')" });
    }

    const { buffer, mimeType } = await normalizeLogoUpload(
      req.file.buffer,
      req.file.mimetype
    );

    await saveCompanyLogo(companyId, {
      buffer,
      mimeType,
      originalFilename: req.file.originalname,
    });

    res.json({ success: true, mimeType, originalFilename: req.file.originalname });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/companies/:companyId/logo/meta
 * Metadata only (not the image bytes) — for a settings page.
 */
router.get("/:companyId/logo/meta", async (req, res) => {
  try {
    const meta = await getCompanyLogoMeta(req.params.companyId);
    res.json(meta);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/companies/:companyId/logo
 */
router.delete("/:companyId/logo", async (req, res) => {
  try {
    await deleteCompanyLogo(req.params.companyId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;