// src/api/gstr3b.routes.js
//
// Mounted as: app.use("/api/gst/gstr3b", ...requireSessionAndCompany(), gstr3bRoutes)
// The app-level company guard already checked body/query companyId.
//
// GSTR-3B: prepare from the books, then on the portal — check against the
// auto-calculated values, save, plan the payment, offset, EVC OTP, file.

import express from "express";
import { resolveUserId } from "../utils/resolveUserId.js";
import { prepareGstr3b, getGstr3bRun } from "../services/gstr3b/gstr3b.service.js";
import {
  checkGstr3bOnPortal, saveGstr3bToPortal, checkGstr3bSaveStatus, planGstr3bPayment,
  offsetGstr3b, confirmOffset, sendGstr3bOtp, fileGstr3b,
} from "../services/gstr3b/gstr3bFile.service.js";

const router = express.Router();

const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const fail = (res, err, label) => {
  console.log(`GSTR3B ${label} ERROR:`, err, err.details || "");
  const code = typeof err.code === "number" ? err.code : err.details ? 502 : 500;
  return res.status(code).json({ status: "error", message: err.message });
};

/* =========================================
   PREPARE
   Body: { companyId, gstin, retPeriod: "062026", frequency }
========================================= */
router.post("/prepare", async (req, res) => {
  try {
    const { companyId, gstin, retPeriod, frequency } = req.body;
    if (!companyId || !gstin || !retPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and retPeriod are required" });
    }
    const createdBy = await resolveUserId(req).catch(() => null);
    return res.json({ status: "success", data: await prepareGstr3b({ companyId, gstin, retPeriod, frequency, createdBy }) });
  } catch (err) {
    return fail(res, err, "PREPARE");
  }
});

/* =========================================
   RUN — stored result for a period
   Query: ?companyId=&gstin=&period=06-2026
========================================= */
router.get("/run", async (req, res) => {
  try {
    const { companyId, gstin, period } = req.query;
    if (!companyId || !gstin || !period) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and period are required" });
    }
    return res.json({ status: "success", data: await getGstr3bRun({ companyId, gstin, period }) });
  } catch (err) {
    return fail(res, err, "RUN");
  }
});

/** { companyId, gstin, period } from the body, or a 400. */
const periodArgs = (body, res) => {
  const { companyId, gstin, period } = body;
  if (!companyId || !gstin || !period) {
    res.status(400).json({ status: "error", message: "companyId, gstin and period are required" });
    return null;
  }
  return { companyId, gstin, period };
};

/* =========================================
   CHECK ON PORTAL (autoliab + validateautocalculatedata)
   Body: { companyId, gstin, period }
========================================= */
router.post("/check", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await checkGstr3bOnPortal({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "CHECK");
  }
});

/* =========================================
   SAVE (retsave) — body may carry acknowledgeWarnings: true
   Body: { companyId, gstin, period }
========================================= */
router.post("/save", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await saveGstr3bToPortal({ ...args, acknowledgeWarnings: req.body.acknowledgeWarnings === true, userId: await resolveUserId(req).catch(() => null), ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "SAVE");
  }
});

/* =========================================
   SAVE STATUS (retstatus)
   Body: { companyId, gstin, period }
========================================= */
router.post("/save-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await checkGstr3bSaveStatus({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "SAVE-STATUS");
  }
});

/* =========================================
   PLAN PAYMENT (retsum + ledgers/bal)
   Body: { companyId, gstin, period }
========================================= */
router.post("/plan", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await planGstr3bPayment({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "PLAN");
  }
});

/* =========================================
   OFFSET LIABILITY (retoffset) — irreversible
   Body: { companyId, gstin, period }
========================================= */
router.post("/offset", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await offsetGstr3b({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "OFFSET");
  }
});

/* =========================================
   CONFIRM OFFSET (final retsum)
   Body: { companyId, gstin, period }
========================================= */
router.post("/offset-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await confirmOffset({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "OFFSET-STATUS");
  }
});

/* =========================================
   EVC OTP (form R3B) — body: pan
   Body: { companyId, gstin, period }
========================================= */
router.post("/otp", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await sendGstr3bOtp({ ...args, pan: req.body.pan, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "OTP");
  }
});

/* =========================================
   FILE (retevcfile) — body: pan, evcOtp
   Body: { companyId, gstin, period }
========================================= */
router.post("/file", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await fileGstr3b({ ...args, pan: req.body.pan, evcOtp: req.body.evcOtp, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "FILE");
  }
});

export default router;
