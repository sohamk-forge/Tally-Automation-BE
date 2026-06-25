import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";

const router = express.Router();

/* =========================================
   GENERATE CONNECTOR KEY
========================================= */

router.post("/generate-key", async (req, res) => {
  try {

    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    const token =
      "PAIR-" +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    const expiresAt = new Date(
      Date.now() + 10 * 60 * 1000
    );

    await pool.query(
      `
      INSERT INTO app_test.connector_pairing_tokens
      (
        id,
        user_id,
        token,
        expires_at
      )
      VALUES
      (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
      `,
      [
        user_id,
        token,
        expiresAt
      ]
    );

    return res.status(200).json({
      status: "success",
      token,
      expires_at: expiresAt
    });

  } catch (err) {

    console.error("Generate Key Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});


/* =========================================
   CONNECTOR PAIR
========================================= */

router.post("/pair", async (req, res) => {
  try {
    const { token, machine_id } = req.body;

    if (!token) {
      return res.status(400).json({
        status: "error",
        message: "token is required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.connector_pairing_tokens
      WHERE token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Invalid token"
      });
    }

    const pairingToken = result.rows[0];

    // Check if token already used
    if (pairingToken.is_used) {
      return res.status(400).json({
        status: "error",
        message: "Token already used"
      });
    }

    // Check expiry
    if (new Date(pairingToken.expires_at) < new Date()) {
      return res.status(400).json({
        status: "error",
        message: "Token expired"
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Token is valid",
      data: {
        user_id: pairingToken.user_id,
        token: pairingToken.token,
        machine_id
      }
    });

  } catch (err) {
    console.error("Pair Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;