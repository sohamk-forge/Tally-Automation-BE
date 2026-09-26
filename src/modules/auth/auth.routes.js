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

// Register Route
router.post(
  "/register",
  authController.register
);

// Login Route
router.post(
  "/login",
  authController.login
);

export default router;