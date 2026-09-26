// src/api/gstAuth.routes.js
//
// Mounted as: app.use("/api/gst/auth", ...requireSessionOrApiKey(), gstAuthRoutes)
// requireSessionOrApiKey() already resolved auth via ONE of three paths
// before we get here:
//   1. Browser session -> req.session is a SuperTokens session object
//   2. Internal service call -> req.internalUserId (already a local numeric id)
//   3. Desktop connector API key -> req.connectorMachine = { userId, machineId }
// No verifySession() here — calling it again would re-check headers/cookies
// and break paths 2 and 3, which never had a SuperTokens session to begin with.

import express from "express";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import {
  startGstOtpRequest,
  verifyGstOtp,
  getGstConnectionStatus,
} from "../services/gstAuth.service.js";

const router = express.Router();

/**
 * Resolve "who made this request" as a local numeric user id, whichever
 * of the three auth paths it came through. Used for gst_auth_sessions.created_by.
 */
async function resolveUserId(req) {
  if (req.session) {
    return getLocalUserId(req.session.getUserId());
  }
  if (req.internalUserId) {
    return req.internalUserId;
  }
  if (req.connectorMachine) {
    return req.connectorMachine.userId;
  }
  return null;
}

/**
 * WhiteBooks requires an ip_address header on every call. req.ip respects
 * Express's "trust proxy" setting if you have one configured; falls back
 * to the raw socket address otherwise. Strips the ::ffff: IPv4-mapped
 * IPv6 prefix that Node sometimes adds for localhost/IPv4 clients.
 */
function getClientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || "";
  return ip.replace(/^::ffff:/, "");
}

/* =========================================
   REQUEST OTP
   Body: {
     companyId, gstin, clientId, clientSecret, gstUsername,
     whitebooksEmail,   // the WhiteBooks account email for THIS company
     gstPassword?
   }

   gstUsername and whitebooksEmail are REQUIRED — different companies can
   have entirely different WhiteBooks developer accounts, so nothing here
   is a shared global constant.
========================================= */
router.post("/request-otp", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const {
      companyId,
      gstin,
      clientId,
      clientSecret,
      gstUsername,
      whitebooksEmail,
      gstPassword,
    } = req.body;

    if (!companyId || !gstin || !clientId || !clientSecret || !gstUsername || !whitebooksEmail) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin, clientId, clientSecret, gstUsername and whitebooksEmail are required",
      });
    }

    const { txn, message } = await startGstOtpRequest({
      companyId,
      gstin,
      clientId,
      clientSecret,
      gstUsername,
      whitebooksEmail,
      gstPassword,
      createdBy: userId,
      ipAddress: getClientIp(req),
    });

    return res.json({ status: "success", message, data: { txn } });
  } catch (err) {
    console.log("GST REQUEST-OTP ERROR:", err, err.details);
    return res.status(502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   VERIFY OTP
   Body: { companyId, gstin, txn, otp }
   whitebooksEmail/gstUsername are read back from gst_credentials — you
   don't resend them here.
========================================= */
router.post("/verify-otp", async (req, res) => {
  try {
    const { companyId, gstin, txn, otp } = req.body;
    if (!companyId || !gstin || !txn || !otp) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin, txn and otp are required",
      });
    }

    const result = await verifyGstOtp({
      companyId,
      gstin,
      txn,
      otp,
      ipAddress: getClientIp(req),
    });
    if (result.error) {
      return res.status(result.code || 400).json({ status: "error", message: result.error });
    }

    return res.json({
      status: "success",
      message: result.alreadyDone ? "Already authenticated" : "GST authentication successful",
      data: { gstin, status: result.status },
    });
  } catch (err) {
    console.log("GST VERIFY-OTP ERROR:", err, err.details);
    return res.status(502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   CONNECTION STATUS
   Query: ?gstin=...
========================================= */
router.get("/status/:companyId", async (req, res) => {
  try {
    const { companyId } = req.params;
    const { gstin } = req.query;
    if (!gstin) {
      return res.status(400).json({ status: "error", message: "gstin query param is required" });
    }

    const result = await getGstConnectionStatus({ companyId, gstin });
    return res.json({ status: "success", data: result });
  } catch (err) {
    console.log("GST STATUS ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;