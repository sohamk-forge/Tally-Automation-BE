// src/api/gstr1Prepare.routes.js
//
// Mounted as: app.use("/api/gst/gstr1", ...requireSessionAndCompany(), gstr1PrepareRoutes)
// The app-level company guard already checked body/query companyId.
//
// Stage 1 (Prepare) of the GSTR-1 pipeline — offline, no WhiteBooks calls —
// stage 2 (Save to the GST portal: retsave + retstatus, reset) and stages
// 3–9 (validate on the portal, proceed to file, EVC OTP, file).

import express from "express";
import { resolveUserId } from "../utils/resolveUserId.js";
import { prepareGstr1, getRun, saveHsnOverrides } from "../services/gstr1/gstr1Prepare.service.js";
import { saveGstr1ToPortal, checkGstr1SaveStatus, resetGstr1OnPortal } from "../services/gstr1/gstr1Save.service.js";
import { validateOnPortal, proceedToFile, checkProceedStatus, sendFilingOtp, fileGstr1 } from "../services/gstr1/gstr1File.service.js";

const router = express.Router();

const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const fail = (res, err, label) => {
  console.log(`GSTR1 ${label} ERROR:`, err, err.details || "");
  // WhiteBooks failures carry no HTTP code of their own -> 502.
  const code = typeof err.code === "number" ? err.code : err.details ? 502 : 500;
  return res.status(code).json({ status: "error", message: err.message });
};

/** Body/query check shared by the portal endpoints. */
const periodArgs = (src, res) => {
  const { companyId, gstin, period } = src;
  if (!companyId || !gstin || !period) {
    res.status(400).json({ status: "error", message: "companyId, gstin and period are required" });
    return null;
  }
  return { companyId, gstin, period };
};

/* =========================================
   PREPARE
   Body: { companyId, gstin, retPeriod: "062026", frequency: "MONTHLY" | "QUARTERLY" }
   Builds the retsave JSON from the period's vouchers, validates it, stores
   it as the period's run and returns it.
========================================= */
router.post("/prepare", async (req, res) => {
  try {
    const { companyId, gstin, retPeriod, frequency } = req.body;
    if (!companyId || !gstin || !retPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and retPeriod are required" });
    }
    const createdBy = await resolveUserId(req).catch(() => null);
    const run = await prepareGstr1({ companyId, gstin, retPeriod, frequency, createdBy });
    return res.json({ status: "success", data: run });
  } catch (err) {
    return fail(res, err, "PREPARE");
  }
});

/* =========================================
   RUN (stored result for a period)
   Query: ?companyId=&gstin=&period=06-2026
========================================= */
router.get("/run", async (req, res) => {
  try {
    const { companyId, gstin, period } = req.query;
    if (!companyId || !gstin || !period) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and period are required" });
    }
    const run = await getRun({ companyId, gstin, period });
    return res.json({ status: "success", data: run });
  } catch (err) {
    return fail(res, err, "RUN");
  }
});

/* =========================================
   HSN / RATE OVERRIDES
   Body: { companyId, overrides: [{ itemName, hsnCode?, gstRate?, uqc? }] }
   Fills GST details missing from Tally masters; used on the next Prepare.
========================================= */
router.put("/hsn-overrides", async (req, res) => {
  try {
    const { companyId, overrides } = req.body;
    if (!companyId || !Array.isArray(overrides) || !overrides.length) {
      return res.status(400).json({ status: "error", message: "companyId and a non-empty overrides list are required" });
    }
    const updatedBy = await resolveUserId(req).catch(() => null);
    const saved = await saveHsnOverrides({ companyId, overrides, updatedBy });
    return res.json({ status: "success", data: saved });
  } catch (err) {
    return fail(res, err, "HSN-OVERRIDES");
  }
});

/* =========================================
   SAVE TO PORTAL (PUT /gstr1/retsave)
   Body: { companyId, gstin, period: "06-2026" }
   Uploads the prepared return; GSTN processes it asynchronously — poll
   /save-status until the run leaves SAVE_PENDING.
========================================= */
router.post("/save", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    const createdBy = await resolveUserId(req).catch(() => null);
    return res.json({ status: "success", data: await saveGstr1ToPortal({ ...args, ipAddress: clientIp(req), createdBy }) });
  } catch (err) {
    return fail(res, err, "SAVE");
  }
});

/* =========================================
   SAVE STATUS (GET /gstr/retstatus)
   Body: { companyId, gstin, period }
========================================= */
router.post("/save-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await checkGstr1SaveStatus({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "SAVE-STATUS");
  }
});

/* =========================================
   RESET PORTAL DATA (POST /gstr1/reset)
   Body: { companyId, gstin, period }
========================================= */
router.post("/reset", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await resetGstr1OnPortal({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "RESET");
  }
});

/* =========================================
   VALIDATE ON PORTAL (validatehsnsum + retsum compared with what we saved)
   Body: { companyId, gstin, period }
========================================= */
router.post("/validate", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await validateOnPortal({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "VALIDATE");
  }
});

/* =========================================
   PROCEED TO FILE (newproceedfile) — freezes the return on the portal
   Body: { companyId, gstin, period, acceptDifferences? }
========================================= */
router.post("/proceed", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    const userId = await resolveUserId(req).catch(() => null);
    return res.json({ status: "success", data: await proceedToFile({ ...args, acceptDifferences: req.body.acceptDifferences === true, ipAddress: clientIp(req), userId }) });
  } catch (err) {
    return fail(res, err, "PROCEED");
  }
});

/* =========================================
   PROCEED STATUS (newretstatus) — on success fetches the final summary
   Body: { companyId, gstin, period }
========================================= */
router.post("/proceed-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await checkProceedStatus({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "PROCEED-STATUS");
  }
});

/* =========================================
   EVC OTP (otpforevc, form_type R1)
   Body: { companyId, gstin, period, pan }
========================================= */
router.post("/otp", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await sendFilingOtp({ ...args, pan: req.body.pan, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "OTP");
  }
});

/* =========================================
   FILE (retevcfile)
   Body: { companyId, gstin, period, pan, evcOtp }
========================================= */
router.post("/file", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    const userId = await resolveUserId(req).catch(() => null);
    return res.json({ status: "success", data: await fileGstr1({ ...args, pan: req.body.pan, evcOtp: req.body.evcOtp, ipAddress: clientIp(req), userId }) });
  } catch (err) {
    return fail(res, err, "FILE");
  }
});

export default router;
