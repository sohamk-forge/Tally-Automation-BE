import express from "express";

const router = express.Router();

import authController from "./auth.controller.js";
import authMiddleware from "../../middleware/auth.middleware.js";

// Logout Route
router.post(
  "/logout",
  authMiddleware,
  authController.logout
);

// Current User Route
router.get(
  "/me",
  authMiddleware,
  authController.me
);

// Register Route (Step 1 — sends verification email)
router.post(
  "/register",
  authController.register
);

// Verify Email Route (Step 2 — actually creates the user)
router.post(
  "/verify-email",
  authController.verifyEmail
);

// Resend Verification Email Route
router.post(
  "/resend-verification",
  authController.resendVerification
);

// Login Route
router.post(
  "/login",
  authController.login
);

// Send OTP route
router.post(
  "/send-otp",
  authController.sendOtp
);

// Verify OTP route
router.post(
  "/verify-otp",
  authController.verifyOtp
);

export default router;