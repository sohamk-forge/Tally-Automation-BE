import express from "express";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendSignupOtp, verifySignupOtp } from "../services/otp.service.js";

const router = express.Router();

/* =========================================
   MY VERIFICATION STATUS
   Frontend checks this right after signup to decide whether to show the
   OTP entry screen before letting the user into the app.
========================================= */
router.get("/status", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const result = await pool.query(
      `SELECT email, email_verified FROM ${DB_SCHEMA}.users WHERE id = $1`,
      [userId]
    );

    return res.json({ status: "success", data: result.rows[0] });
  } catch (err) {
    console.log("EMAIL VERIFICATION STATUS ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   RESEND OTP
========================================= */
router.post("/resend", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const userResult = await pool.query(
      `SELECT email, email_verified FROM ${DB_SCHEMA}.users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }
    if (user.email_verified) {
      return res.status(409).json({ status: "error", message: "Email is already verified" });
    }

    const result = await sendSignupOtp(user.email);
    if (result.throttled) {
      return res.status(429).json({
        status: "error",
        message: `Please wait ${result.retryAfterSeconds}s before requesting another code`,
      });
    }

    return res.json({ status: "success", message: "Verification code sent" });
  } catch (err) {
    console.log("OTP RESEND ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   VERIFY OTP
========================================= */
router.post("/verify", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const { otp } = req.body;
    if (!otp) {
      return res.status(400).json({ status: "error", message: "otp is required" });
    }

    const userResult = await pool.query(
      `SELECT email FROM ${DB_SCHEMA}.users WHERE id = $1`,
      [userId]
    );
    const email = userResult.rows[0]?.email;
    if (!email) {
      return res.status(404).json({ status: "error", message: "No profile found for this account" });
    }

    const result = await verifySignupOtp(email, otp);

    if (result.error === "no_otp_requested") {
      return res.status(400).json({ status: "error", message: "No verification code was requested for this email" });
    }
    if (result.error === "too_many_attempts") {
      return res.status(429).json({ status: "error", message: "Too many incorrect attempts — request a new code" });
    }
    if (result.error === "expired") {
      return res.status(400).json({ status: "error", message: "Code expired — request a new one" });
    }
    if (result.error === "invalid_code") {
      return res.status(400).json({ status: "error", message: "Incorrect code" });
    }

    return res.json({ status: "success", message: "Email verified" });
  } catch (err) {
    console.log("OTP VERIFY ERROR:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
