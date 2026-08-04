import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const CONNECTOR_ONLINE_WINDOW = "30 seconds";

export const resolveConnectorForCompany = async (
  companyId,
  actingUserId
) => {

  if (!companyId) {
    throw new Error("companyId is required");
  }

  if (!actingUserId) {
    throw new Error("actingUserId is required");
  }

  // =====================================================
  // ONLY THE USER WHO MADE THE REQUEST
  // =====================================================

  const own = await pool.query(
    `
    SELECT
      cak.user_id,
      cak.id AS api_key_id,
      cak.last_seen_at
    FROM ${DB_SCHEMA}.connector_api_keys cak
    WHERE cak.user_id = $1
      AND cak.revoked_at IS NULL

      AND cak.last_seen_at >=
          NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'

      AND EXISTS (
        SELECT 1
        FROM ${DB_SCHEMA}.connector_pairing_tokens cpt
        WHERE cpt.user_id = cak.user_id
          AND cpt.company_id = $2
          AND cpt.is_used = TRUE
      )

    ORDER BY cak.last_seen_at DESC
    LIMIT 1
    `,
    [
      actingUserId,
      companyId
    ]
  );

  if (own.rows[0]) {

    console.log("✅ OWN CONNECTOR SELECTED:", {
      actingUserId,
      companyId,
      connectorUserId: own.rows[0].user_id,
      lastSeenAt: own.rows[0].last_seen_at
    });

    return own.rows[0];
  }

  // =====================================================
  // IMPORTANT:
  // DO NOT FALLBACK TO ANOTHER USER
  // =====================================================

  console.warn("❌ NO OWN CONNECTOR AVAILABLE:", {
    actingUserId,
    companyId
  });

  return null;
};