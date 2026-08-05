import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
/**
 * app_test tables (connector_pairing_tokens, connector_api_keys, job_logs, ...)
 * key off the pre-existing integer ${DB_SCHEMA}.users.id, not the SuperTokens
 * user id (a UUID) — this resolves a session to that local id.
 */
export const getLocalUserId = async (supertokensUserId) => {
  const result = await pool.query(
    `
    SELECT id
    FROM ${DB_SCHEMA}.users
    WHERE supertokens_user_id = $1
    LIMIT 1
    `,
    [supertokensUserId]
  );

  return result.rows[0]?.id ?? null;
};
