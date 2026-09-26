// src/api/gstr1.routes.js
//
// Mounted as: app.use("/api/gst/gstr1", ...requireSessionOrApiKey(), gstr1Routes)
// Same auth pattern as gstAuth.routes.js / gstReturnStatus.routes.js — no
// verifySession() here, read whichever of the 3 auth paths
// requireSessionOrApiKey() already resolved.
import express from "express";
import { saveDraft, getSummary, fileReturn, resetDraft, getFilingHistory } from "../services/gstr1.service.js";

const router = express.Router();

/* =========================================
   SAVE DRAFT
   Body: { companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, gstr1Payload }
========================================= */
router.post("/save", async (req, res) => {
  try {
    const { companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, gstr1Payload } = req.body;
    if (!companyId || !gstin || !financialYear || !returnPeriod || !gstr1Payload) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin, financialYear, returnPeriod and gstr1Payload are required",
      });
    }
    const createdBy = req.user?.id || null;
    const result = await saveDraft({ companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, createdBy, gstr1Payload });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GSTR1 SAVE ERROR:", err, err.details);
    return res.status(err.code || 502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   GET SUMMARY (checksums — must be called right before filing)
   Query: ?companyId=&gstin=&returnPeriod=&gstUsername=&ipAddress=&summaryType=
========================================= */
router.get("/summary", async (req, res) => {
  try {
    const { companyId, gstin, returnPeriod, gstUsername, ipAddress, summaryType } = req.query;
    if (!companyId || !gstin || !returnPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and returnPeriod are required" });
    }
    const result = await getSummary({ companyId, gstin, returnPeriod, gstUsername, ipAddress, summaryType });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GSTR1 SUMMARY ERROR:", err, err.details);
    return res.status(err.code || 502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   FILE RETURN (EVC/OTP)
   Body: { companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, pan, evcOtp, chksum, secSum }
========================================= */
router.post("/file", async (req, res) => {
  try {
    const { companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, pan, evcOtp, chksum, secSum } = req.body;
    if (!companyId || !gstin || !financialYear || !returnPeriod || !pan || !evcOtp || !chksum) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin, financialYear, returnPeriod, pan, evcOtp and chksum are required",
      });
    }
    const createdBy = req.user?.id || null;
    const result = await fileReturn({ companyId, gstin, financialYear, returnPeriod, gstUsername, ipAddress, pan, evcOtp, chksum, secSum, createdBy });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GSTR1 FILE ERROR:", err, err.details);
    return res.status(err.code || 502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   RESET DRAFT
   Body: { companyId, gstin, returnPeriod, gstUsername, ipAddress }
========================================= */
router.post("/reset", async (req, res) => {
  try {
    const { companyId, gstin, returnPeriod, gstUsername, ipAddress } = req.body;
    if (!companyId || !gstin || !returnPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and returnPeriod are required" });
    }
    const result = await resetDraft({ companyId, gstin, returnPeriod, gstUsername, ipAddress });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GSTR1 RESET ERROR:", err, err.details);
    return res.status(err.code || 502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   FILING HISTORY (reads gst_gstr1_filings audit table, no WhiteBooks call)
   Query: ?companyId=&gstin=&financialYear=&returnPeriod=
========================================= */
router.get("/history", async (req, res) => {
  try {
    const { companyId, gstin, financialYear, returnPeriod } = req.query;
    if (!companyId || !gstin || !financialYear || !returnPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin, financialYear and returnPeriod are required" });
    }
    const result = await getFilingHistory({ companyId, gstin, financialYear, returnPeriod });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GSTR1 HISTORY ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;