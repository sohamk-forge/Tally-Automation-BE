import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

/**
 * Jobs must be queued under whichever user's connector machine will
 * actually poll for them (connector_api_keys is keyed by user_id+machine_id,
 * not company) — so routing by the acting user's own id breaks the moment
 * someone other than the original pairer (e.g. an invited teammate) triggers
 * a push. This resolves the live, currently-heartbeating connector among
 * everyone with used pairing-token access to the company — for an invited
 * user's company that's always the original inviter's machine, since only
 * they ever actually paired one, regardless of who triggered the push.
 */
export const resolveConnectorForCompany = async (companyId) => {
  const result = await pool.query(
    `
    SELECT cak.user_id, cak.machine_id
    FROM ${DB_SCHEMA}.connector_pairing_tokens cpt
    JOIN ${DB_SCHEMA}.connector_api_keys cak
      ON cak.user_id = cpt.user_id
     AND cak.revoked_at IS NULL
    WHERE cpt.company_id = $1
      AND cpt.is_used = TRUE
      AND cak.last_seen_at >= NOW() - INTERVAL '30 seconds'
    ORDER BY cak.last_seen_at DESC
    LIMIT 1
    `,
    [companyId]
  );

  return result.rows[0] ?? null;
};
