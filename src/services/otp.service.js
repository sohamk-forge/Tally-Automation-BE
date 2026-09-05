import crypto from "crypto";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendOtpEmail } from "./mailer.service.js";

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
// Caps total sends per email even if each individual resend respects the
// 60s cooldown (60/hr would otherwise be reachable by hammering /resend).
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MINUTES = 60;

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");

const generateOtp = () =>
  crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");

/**
 * Generates and emails a signup verification code. Called right after a
 * fresh EmailPassword signup (see supertokens.js) and from the resend
 * endpoint. Throttled per-email so a stuck frontend retry loop can't spam
 * the inbox / SMTP relay.
 */
export const sendSignupOtp = async (email) => {
  const recent = await pool.query(
    `
    SELECT created_at
    FROM ${DB_SCHEMA}.email_otps
    WHERE email = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [email]
  );

  if (recent.rows[0]) {
    const elapsedSeconds = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
    if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
      return {
        throttled: true,
        reason: "cooldown",
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds),
      };
    }
  }

  const countResult = await pool.query(
    `
    SELECT count(*)::int AS count, min(created_at) AS oldest
    FROM ${DB_SCHEMA}.email_otps
    WHERE email = $1
      AND created_at > now() - interval '${SEND_WINDOW_MINUTES} minutes'
    `,
    [email]
  );

  const { count, oldest } = countResult.rows[0];
  if (count >= MAX_SENDS_PER_WINDOW) {
    const elapsedSeconds = (Date.now() - new Date(oldest).getTime()) / 1000;
    const retryAfterSeconds = Math.ceil(SEND_WINDOW_MINUTES * 60 - elapsedSeconds);
    return { throttled: true, reason: "hourly_limit", retryAfterSeconds };
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.email_otps (email, otp_hash, expires_at)
    VALUES ($1, $2, $3)
    `,
    [email, hashOtp(otp), expiresAt]
  );

  await sendOtpEmail(email, otp);

  return { throttled: false };
};

/**
 * Verifies the most recently issued OTP for an email. Only that latest row
 * is checked — requesting a new code invalidates any earlier one implicitly,
 * since attempts against stale rows will just fail the hash comparison.
 */
export const verifySignupOtp = async (email, code) => {
  const result = await pool.query(
    `
    SELECT id, otp_hash, expires_at, attempts
    FROM ${DB_SCHEMA}.email_otps
    WHERE email = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [email]
  );

  const row = result.rows[0];
  if (!row) {
    return { success: false, error: "no_otp_requested" };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { success: false, error: "too_many_attempts" };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { success: false, error: "expired" };
  }

  if (hashOtp(String(code)) !== row.otp_hash) {
    await pool.query(
      `UPDATE ${DB_SCHEMA}.email_otps SET attempts = attempts + 1 WHERE id = $1`,
      [row.id]
    );
    return { success: false, error: "invalid_code" };
  }

  await pool.query(
    `UPDATE ${DB_SCHEMA}.users SET email_verified = true, updated_at = now() WHERE email = $1`,
    [email]
  );
  await pool.query(`DELETE FROM ${DB_SCHEMA}.email_otps WHERE email = $1`, [email]);

  return { success: true };
};
