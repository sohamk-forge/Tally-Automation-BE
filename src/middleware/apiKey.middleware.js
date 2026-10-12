import crypto from "crypto";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

export const hashApiKey = (rawKey) =>
  crypto.createHash("sha256").update(rawKey).digest("hex");

// Set once the new tally_* columns turn out not to exist (migration not run
// on this database yet), so every poll stops retrying the failing statement.
let tallyColumnsMissing = false;

// The connector reports whether Tally answers on its machine with each job
// poll: x-tally-connected = "true"|"false", x-tally-checked-ago-ms = how old
// that check is. An age (not a timestamp) so a wrong clock on the connector
// PC can't make the status look fresh or stale.
const readTallyReport = (req) => {
  const connected = req.headers["x-tally-connected"];
  const ageMs = Number(req.headers["x-tally-checked-ago-ms"]);

  if ((connected !== "true" && connected !== "false") || !Number.isFinite(ageMs) || ageMs < 0) {
    return null;
  }

  return { connected: connected === "true", ageMs: Math.min(Math.round(ageMs), 10 * 60 * 1000) };
};

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

    // Live heartbeat — connector is currently running. Carries the connector's
    // latest "is Tally up?" check when it sent one, in the same statement.
    const tally = tallyColumnsMissing ? null : readTallyReport(req);

    const touch = tally
      ? pool
          .query(
            `
            UPDATE ${DB_SCHEMA}.connector_api_keys
            SET last_seen_at = NOW(),
                tally_connected = $2,
                tally_checked_at = NOW() - ($3 * INTERVAL '1 millisecond')
            WHERE key_hash = $1
            `,
            [keyHash, tally.connected, tally.ageMs]
          )
          .catch((err) => {
            if (err.code !== "42703") throw err; // 42703 = column does not exist
            tallyColumnsMissing = true;
            console.error("connector_api_keys.tally_* missing — run `npm run migrate:latest`");
            return pool.query(
              `UPDATE ${DB_SCHEMA}.connector_api_keys SET last_seen_at = NOW() WHERE key_hash = $1`,
              [keyHash]
            );
          })
      : pool.query(
          `
          UPDATE ${DB_SCHEMA}.connector_api_keys
          SET last_seen_at = NOW()
          WHERE key_hash = $1
          `,
          [keyHash]
        );

    touch.catch((err) => {
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