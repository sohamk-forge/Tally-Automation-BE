import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

/**
 * GET USER DETAILS BY EMAIL
 *
 * GET /api/users/by-email?email=test@gmail.com
 *
 * Used at login time by the frontend: user enters an email, this looks
 * it up in app_test.users and returns first_name/last_name/email/role.
 * Never returns password.
 */
router.get("/by-email", async (req, res) => {
  try {
    const { email } = req.query;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `
      SELECT
        first_name,
        last_name,
        email,
        role
      FROM ${DB_SCHEMA}.users
      WHERE LOWER(email) = $1
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = result.rows[0];

    return res.status(200).json({
      success: true,
      message: "User details fetched successfully",
      data: {
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error fetching user by email:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;