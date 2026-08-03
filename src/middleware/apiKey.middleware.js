import crypto from "crypto";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

export const hashApiKey = (rawKey) =>
  crypto.createHash("sha256").update(rawKey).digest("hex");

export const verifyConnectorApiKey = async (req, res, next) => {
  const rawKey = req.headers["x-connector-api-key"];

  if (!rawKey) {
    return res.status(401).json({
      status: "error",
      message: "Missing or invalid credentials",
    });
  }

  try {
    const keyHash = hashApiKey(rawKey);

    const result = await pool.query(
      `
      SELECT user_id, machine_id
      FROM ${DB_SCHEMA}.connector_api_keys
      WHERE key_hash = $1
        AND revoked_at IS NULL
      LIMIT 1
      `,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Missing or invalid credentials",
      });
    }

    const row = result.rows[0];

    // Live heartbeat — connector is currently running
    pool.query(
      `
      UPDATE ${DB_SCHEMA}.connector_api_keys
      SET last_seen_at = NOW()
      WHERE key_hash = $1
      `,
      [keyHash]
    ).catch((err) => {
      console.error("Connector heartbeat update failed:", err.message);
    });

    req.connectorMachine = {
      userId: row.user_id,
      machineId: row.machine_id,
    };

    return next();

  } catch (err) {
    return next(err);
  }
};