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
  // FIND OWNER'S LATEST LIVE CONNECTOR
  //
  // Rules:
  // 1. Only the requesting user is considered
  // 2. Company must match
  // 3. Pairing must be completed
  // 4. Latest pairing is selected
  // 5. Pairing machine_id must match connector machine_id
  // 6. API key user/company must match
  // 7. API key must not be revoked
  // 8. Connector must be live within 30 seconds
  // 9. NEVER fallback to another user's connector
  // =====================================================

  const result = await pool.query(
    `
    WITH latest_pairing AS (
      SELECT
        cpt.id AS pairing_id,
        cpt.user_id,
        cpt.company_id,
        cpt.machine_id,
        cpt.created_at AS pairing_created_at

      FROM ${DB_SCHEMA}.connector_pairing_tokens cpt

      WHERE cpt.user_id = $1
        AND cpt.company_id = $2
        AND cpt.is_used = TRUE
        AND cpt.machine_id IS NOT NULL

      ORDER BY
        cpt.created_at DESC,
        cpt.id DESC

      LIMIT 1
    )

    SELECT
      cak.user_id,
      cak.id AS api_key_id,
      cak.machine_id,
      cak.company_id,
      cak.last_seen_at,
      lp.pairing_id,
      lp.pairing_created_at

    FROM latest_pairing lp

    INNER JOIN ${DB_SCHEMA}.connector_api_keys cak
      ON cak.user_id = lp.user_id
      AND cak.machine_id = lp.machine_id
      AND cak.company_id = lp.company_id

    WHERE cak.revoked_at IS NULL
      AND cak.last_seen_at >=
          NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'

    ORDER BY
      cak.last_seen_at DESC,
      cak.id DESC

    LIMIT 1
    `,
    [
      actingUserId,
      companyId
    ]
  );

  // =====================================================
  // CONNECTOR FOUND
  // =====================================================

  if (result.rows.length > 0) {
    const connector = result.rows[0];

    console.log("✅ OWNER CONNECTOR SELECTED:", {
      actingUserId,
      companyId,
      connectorUserId: connector.user_id,
      machineId: connector.machine_id,
      apiKeyId: connector.api_key_id,
      pairingId: connector.pairing_id,
      pairingCreatedAt: connector.pairing_created_at,
      lastSeenAt: connector.last_seen_at
    });

    return connector;
  }

  // =====================================================
  // OWNER CONNECTOR NOT FOUND / OFFLINE
  // =====================================================

  console.warn("❌ OWNER CONNECTOR NOT LIVE:", {
    actingUserId,
    companyId
  });

  return null;
};