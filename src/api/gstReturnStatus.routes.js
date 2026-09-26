// src/api/gstReturnStatus.routes.js
//
// Mounted as: app.use("/api/gst/return-status", ...requireSessionOrApiKey(), gstReturnStatusRoutes)
// Same auth pattern as gstAuth.routes.js — no verifySession() here, read
// whichever of the 3 auth paths requireSessionOrApiKey() already resolved.

import express from "express";
import { checkReturnStatus, getLatestReturnStatus } from "../services/gstReturnStatus.service.js";

const router = express.Router();

/* =========================================
   CHECK RETURN STATUS (hits WhiteBooks, stores a new row)
   Body: { companyId, gstin, financialYear, returnType }
   financialYear e.g. "2026-27". returnType is a WhiteBooks-defined
   code — confirm valid values before hardcoding any in the frontend.
========================================= */
router.post("/check", async (req, res) => {
  try {
    const { companyId, gstin, financialYear, returnType } = req.body;
    if (!companyId || !gstin || !financialYear || !returnType) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin, financialYear and returnType are required",
      });
    }

    const result = await checkReturnStatus({ companyId, gstin, financialYear, returnType });
    if (result.error) {
      return res.status(result.code || 400).json({ status: "error", message: result.error });
    }

    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GST RETURN-STATUS CHECK ERROR:", err, err.details);
    return res.status(502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   LATEST RETURN STATUS (reads last stored check, no WhiteBooks call)
   Query: ?gstin=...
========================================= */
router.get("/latest/:companyId", async (req, res) => {
  try {
    const { companyId } = req.params;
    const { gstin } = req.query;
    if (!gstin) {
      return res.status(400).json({ status: "error", message: "gstin query param is required" });
    }

    const result = await getLatestReturnStatus({ companyId, gstin });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GST RETURN-STATUS LATEST ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;