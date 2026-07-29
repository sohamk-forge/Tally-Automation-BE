import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";
import { hashApiKey } from "../middleware/apiKey.middleware.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.post("/pair", async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      token,
      machine_id,
      company_name
    } = req.body;

    // Validate token
    if (!token) {
      return res.status(400).json({
        status: "error",
        message: "token is required"
      });
    }

    // Validate machine_id
    if (!machine_id) {
      return res.status(400).json({
        status: "error",
        message: "machine_id is required"
      });
    }

    // Validate company_name
    if (!company_name) {
      return res.status(400).json({
        status: "error",
        message: "company_name is required"
      });
    }

    await client.query("BEGIN");

    // Lock the pairing token row so a concurrent request can't read it
    // before this one marks it used
    const result = await client.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.connector_pairing_tokens
      WHERE token = $1
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "error",
        message: "Invalid token"
      });
    }

    const pairingToken = result.rows[0];

    if (pairingToken.is_used) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "error",
        message: "Token already used"
      });
    }

    if (new Date(pairingToken.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "error",
        message: "Token expired"
      });
    }

    // Fetch user
    const userResult = await client.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.users
      WHERE id = $1
      LIMIT 1
      `,
      [pairingToken.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

   
   const companyUpsertResult = await client.query(
  `
  INSERT INTO ${DB_SCHEMA}.companies (name)
  VALUES ($1)
  ON CONFLICT (name) DO UPDATE
    SET name = EXCLUDED.name
  RETURNING id
  `,
  [company_name]
);
    const companyId = companyUpsertResult.rows[0].id;

    // Generate a long-lived, revocable API key for this machine (shown once —
    // only its hash is stored). Replaces the old 30-day JWT.
    const apiKey = crypto.randomBytes(32).toString("hex");
    const keyHash = hashApiKey(apiKey);

    await client.query(
      `
      INSERT INTO ${DB_SCHEMA}.connector_api_keys
      (
        user_id,
        machine_id,
        key_hash
      )
      VALUES
      (
        $1,
        $2,
        $3
      )
      `,
      [
        user.id,
        machine_id,
        keyHash
      ]
    );

    // Mark token as used and verify update succeeded
    const updateResult = await client.query(
      `
      UPDATE ${DB_SCHEMA}.connector_pairing_tokens
      SET
        is_used = TRUE,
        machine_id = $1,
        company_id = $2
      WHERE id = $3
      RETURNING id
      `,
      [
        machine_id,
        companyId,
        pairingToken.id
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        status: "error",
        message: "Failed to update pairing token"
      });
    }

    await client.query("COMMIT");

    // Return the API key with full user details — the raw key is only ever
    // shown here, the connector app must store it locally.
    return res.status(200).json({
      status: "success",
      message: "Connector paired successfully",
      api_key: apiKey,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name
      }
    });

  } catch (err) {

    await client.query("ROLLBACK").catch(() => {});
    console.error(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  } finally {
    client.release();
  }

});

export default router;