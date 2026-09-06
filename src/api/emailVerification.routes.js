import express from "express";
import rateLimit from "express-rate-limit";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendSignupOtp, verifySignupOtp } from "../services/otp.service.js";

const router = express.Router();

// express-rate-limit's default `message` response has no machine-readable
// retry time — only the otp.service.js per-email throttle returned
// retryAfterSeconds before, so a client hitting this IP-level limiter had
// nothing to build a countdown from. req.rateLimit.resetTime (populated
// because standardHeaders is on) gives us that.
const rateLimitHandler = (req, res) => {
  const resetTime = req.rateLimit?.resetTime;
  const retryAfterSeconds = resetTime
    ? Math.max(1, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
    : undefined;

  return res.status(429).json({
    status: "error",
    message: retryAfterSeconds
      ? `Too many requests — try again in ${retryAfterSeconds}s`
      : "Too many requests — try again later",
    retryAfterSeconds,
  });
};

// IP-level backstop on top of the per-email cooldown/hourly-cap enforced in
// otp.service.js — that logic is keyed by email, so without this a single IP
// could still cycle through many different emails' resend/verify calls
// unthrottled.
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// Verify is brute-force-sensitive (6-digit code), so it gets a tighter cap
// than resend even though each OTP row already locks itself after 5 wrong
// guesses — this stops an attacker from just requesting fresh codes to
// reset that per-row counter and keep guessing.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

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
router.post("/resend", resendLimiter, verifySession(), async (req, res) => {
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
      const message = result.reason === "hourly_limit"
        ? `Too many codes requested — try again in ${Math.ceil(result.retryAfterSeconds / 60)} min`
        : `Please wait ${result.retryAfterSeconds}s before requesting another code`;
      return res.status(429).json({
        status: "error",
        message,
        retryAfterSeconds: result.retryAfterSeconds,
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
router.post("/verify", verifyLimiter, verifySession(), async (req, res) => {
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
