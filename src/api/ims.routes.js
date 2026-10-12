// src/api/ims.routes.js
//
// Mounted as: app.use("/api/gst/ims", ...requireSessionAndCompany(), imsRoutes)
// The app-level company guard already checked body/query companyId.
//
// IMS / GSTR-2B step: fetch + match + review, then save the actions to the
// portal (ims/save + ims/status), regenerate GSTR-2B (gen2b + get2b) and
// verify it (gstr2b/all).

import express from "express";
import { resolveUserId } from "../utils/resolveUserId.js";
import { refreshIms, getImsRun, setImsDecisions } from "../services/ims/ims.service.js";
import { saveImsToPortal, checkImsSaveStatus, generateGstr2b, check2bStatus, verifyGstr2b } from "../services/ims/imsPortal.service.js";

const router = express.Router();

const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const fail = (res, err, label) => {
  console.log(`IMS ${label} ERROR:`, err, err.details);
  return res.status(typeof err.code === "number" ? err.code : 502).json({ status: "error", message: err.message });
};

/* =========================================
   REFRESH — fetch IMS from the portal and match against purchases
   Body: { companyId, gstin, retPeriod: "062026", frequency }
========================================= */
router.post("/refresh", async (req, res) => {
  try {
    const { companyId, gstin, retPeriod, frequency } = req.body;
    if (!companyId || !gstin || !retPeriod) {
      return res.status(400).json({ status: "error", message: "companyId, gstin and retPeriod are required" });
    }
    const createdBy = await resolveUserId(req).catch(() => null);
    const run = await refreshIms({ companyId, gstin, retPeriod, frequency, ipAddress: clientIp(req), createdBy });
    return res.json({ status: "success", data: run });
  } catch (err) {
    return fail(res, err, "REFRESH");
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
    return res.json({ status: "success", data: await getImsRun({ companyId, gstin, period }) });
  } catch (err) {
    return fail(res, err, "RUN");
  }
});

/* =========================================
   DECISIONS — user's accept / reject / pending overrides
   Body: { companyId, gstin, period, decisions: [{ key, action: "A"|"R"|"P"|null }] }
========================================= */
router.put("/decisions", async (req, res) => {
  try {
    const { companyId, gstin, period, decisions } = req.body;
    if (!companyId || !gstin || !period || !Array.isArray(decisions)) {
      return res.status(400).json({ status: "error", message: "companyId, gstin, period and decisions are required" });
    }
    return res.json({ status: "success", data: await setImsDecisions({ companyId, gstin, period, decisions }) });
  } catch (err) {
    return fail(res, err, "DECISIONS");
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
   SAVE ACTIONS TO PORTAL (PUT /ims/save) — only invoices whose action
   differs from the portal's. Poll /save-status afterwards.
   Body: { companyId, gstin, period }
========================================= */
router.post("/save", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await saveImsToPortal({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "SAVE");
  }
});

router.post("/save-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await checkImsSaveStatus({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "SAVE-STATUS");
  }
});

/* =========================================
   REGENERATE GSTR-2B (PUT /gstr2b/gen2b). Poll /gen2b-status; when done,
   2B is fetched and verified against the accepted ITC.
   Body: { companyId, gstin, period }
========================================= */
router.post("/gen2b", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await generateGstr2b({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "GEN2B");
  }
});

router.post("/gen2b-status", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    return res.json({ status: "success", data: await check2bStatus({ ...args, ipAddress: clientIp(req) }) });
  } catch (err) {
    return fail(res, err, "GEN2B-STATUS");
  }
});

/* =========================================
   VERIFY GSTR-2B again (GET /gstr2b/all)
   Body: { companyId, gstin, period, acceptDifferences? }
========================================= */
router.post("/verify", async (req, res) => {
  try {
    const args = periodArgs(req.body, res);
    if (!args) return;
    const userId = await resolveUserId(req).catch(() => null);
    return res.json({ status: "success", data: await verifyGstr2b({ ...args, acceptDifferences: req.body.acceptDifferences === true, ipAddress: clientIp(req), userId }) });
  } catch (err) {
    return fail(res, err, "VERIFY");
  }
});

export default router;
