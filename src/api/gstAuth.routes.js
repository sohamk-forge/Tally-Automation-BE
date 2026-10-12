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
  getGstLoginSetup,
  startGstOtpRequest,
  verifyGstOtp,
  refreshGstSession,
  getGstConnectionStatus,
} from "../services/gstAuth.service.js";
import { companyParamGuard } from "../middleware/companyAccess.middleware.js";

const router = express.Router();

// Every :companyId in this router must belong to the caller.
router.param("companyId", companyParamGuard);

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
   LOGIN SETUP (what the GST Login screen pre-fills)
   -> { gstin, gstinSource, stateCode, gstUsername }
   gstin is null when company_details has none and the user never typed one;
   gstUsername is null on the very first login.
========================================= */
router.get("/credentials/:companyId", async (req, res) => {
  try {
    const data = await getGstLoginSetup({ companyId: req.params.companyId });
    return res.json({ status: "success", data });
  } catch (err) {
    console.log("GST CREDENTIALS ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   REQUEST OTP
   Body: { companyId, gstin, gstUsername }
   Everything else WhiteBooks needs is resolved server-side:
     state_cd       -> first 2 digits of gstin
     ip_address     -> WHITEBOOKS_IP_ADDRESS, else the caller's IP
     client_id/secret, email, base URL -> .env
   The returned txn is stored in gst_auth_sessions.
========================================= */
router.post("/request-otp", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const { companyId, gstin, gstUsername } = req.body;

    if (!companyId || !gstin || !gstUsername) {
      return res.status(400).json({
        status: "error",
        message: "companyId, gstin and gstUsername are required",
      });
    }

    const { txn, message } = await startGstOtpRequest({
      companyId,
      gstin,
      gstUsername,
      createdBy: userId,
      ipAddress: getClientIp(req),
    });

    return res.json({ status: "success", message, data: { txn } });
  } catch (err) {
    console.log("GST REQUEST-OTP ERROR:", err, err.details);
    return res.status(typeof err.code === "number" ? err.code : 502).json({
      status: "error",
      message: err.details?.message || err.message,
      details: err.details,
    });
  }
});

/* =========================================
   VERIFY OTP  (WhiteBooks GET /authentication/authtoken)
   Body: { companyId, gstin, txn, otp }
   -> { gstin, status: "AUTHENTICATED", expiresAt }
   gst_username is read back from gst_credentials; client id/secret/email
   from .env. Wrong OTP -> 400 with WhiteBooks' message, session stays open.
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
      data: { gstin, status: result.status, expiresAt: result.expiresAt },
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
   REFRESH SESSION  (WhiteBooks GET /authentication/refreshtoken)
   Body: { companyId, gstin }  -> { status, expiresAt }
   401 = session expired or refresh rejected; the user must redo OTP.
========================================= */
router.post("/refresh", async (req, res) => {
  try {
    const { companyId, gstin } = req.body;
    if (!companyId || !gstin) {
      return res.status(400).json({ status: "error", message: "companyId and gstin are required" });
    }

    const result = await refreshGstSession({ companyId, gstin, ipAddress: getClientIp(req) });
    if (result.error) {
      return res.status(result.code || 400).json({ status: "error", message: result.error });
    }
    return res.json({
      status: "success",
      message: "GST session refreshed",
      data: { gstin, status: result.status, expiresAt: result.expiresAt },
    });
  } catch (err) {
    console.log("GST REFRESH ERROR:", err, err.details);
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