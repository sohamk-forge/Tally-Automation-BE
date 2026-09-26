import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { redisConnection } from "../config/redis.js";
import { sendConnectorOfflineEmail } from "./mailer.service.js";

export const CONNECTOR_OFFLINE_MEMBER_MESSAGE =
  "The company's Tally connector device is off. Please contact your admin to turn it on.";

const OFFLINE_ALERT_COOLDOWN_SECONDS = 30 * 60;

// One Tally per company, reached through the company's single admin's
// connector. Accountants and staff never hold a connector of their own —
// their work is delegated to the admin's, after the company_members check
// here. Anyone who isn't a member falls through to acting-as-self, which
// preserves the old behaviour (and its "no pairing" failure).
export const resolveTallyOwner = async (companyId, actingUserId) => {
  const result = await pool.query(
    `
    SELECT
      cm.role AS acting_role,
      adm.user_id AS admin_user_id,
      au.email AS admin_email,
      c.name AS company_name
    FROM ${DB_SCHEMA}.companies c
    LEFT JOIN ${DB_SCHEMA}.company_members cm
      ON cm.company_id = c.id AND cm.user_id = $2
    LEFT JOIN ${DB_SCHEMA}.company_members adm
      ON adm.company_id = c.id AND adm.role = 'admin'
    LEFT JOIN ${DB_SCHEMA}.users au ON au.id = adm.user_id
    WHERE c.id = $1
    LIMIT 1
    `,
    [companyId, actingUserId]
  );

  const row = result.rows[0];
  const delegated =
    !!row &&
    (row.acting_role === "accountant" || row.acting_role === "staff") &&
    !!row.admin_user_id;

  return {
    ownerUserId: delegated ? row.admin_user_id : actingUserId,
    delegated,
    adminEmail: delegated ? row.admin_email : null,
    companyName: row?.company_name || `company ${companyId}`
  };
};

export const getConnectorOfflineMessage = async (companyId, actingUserId, defaultMessage) => {
  const owner = await resolveTallyOwner(companyId, actingUserId);
  return owner.delegated ? CONNECTOR_OFFLINE_MEMBER_MESSAGE : defaultMessage;
};

// Emails the company admin when a member's action hits an offline
// connector. Throttled per company via Redis so a burst of retries (or a
// bulk push) sends one email, not one per attempt. Never throws — an alert
// failure must not change the outcome of the request that triggered it.
const notifyAdminConnectorOffline = async (companyId, owner, actingUserId) => {
  try {
    if (!owner.adminEmail) return;

    const claimed = await redisConnection.set(
      `connector-offline-alert:${companyId}`,
      "1",
      "EX",
      OFFLINE_ALERT_COOLDOWN_SECONDS,
      "NX"
    );
    if (!claimed) return;

    const actor = await pool.query(
      `SELECT email FROM ${DB_SCHEMA}.users WHERE id = $1 LIMIT 1`,
      [actingUserId]
    );

    await sendConnectorOfflineEmail(owner.adminEmail, owner.companyName, actor.rows[0]?.email);
  } catch (err) {
    console.error("Failed to send connector-offline alert:", err.message);
  }
};

// Now that pushes are hard-gated on this check (invoices.routes.js rejects
// with 409 when offline), a 30s window would flag a connector as offline
// whenever it is briefly busy inside a slow Tally call and skips a poll.
export const CONNECTOR_ONLINE_WINDOW = "60 seconds";

// Liveness check for the sync path. Deliberately looser than
// resolveConnectorForCompany: syncs only ever needed a used pairing plus a
// connector polling with the owner's key, and some older pairings have no
// machine_id — the strict push-path lookup would wrongly report those
// connectors as off. Emails the admin when a delegated member hits an
// offline connector, same as the strict path.
export const isTallyConnectorLive = async (companyId, actingUserId) => {
  const owner = await resolveTallyOwner(companyId, actingUserId);

  const result = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.connector_api_keys
    WHERE user_id = $1
      AND revoked_at IS NULL
      AND last_seen_at >= NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'
    LIMIT 1
    `,
    [owner.ownerUserId]
  );

  const live = result.rows.length > 0;

  if (!live && owner.delegated) {
    notifyAdminConnectorOffline(companyId, owner, actingUserId);
  }

  return live;
};

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

  const owner = await resolveTallyOwner(companyId, actingUserId);

  // =====================================================
  // FIND OWNER'S LATEST LIVE CONNECTOR
  //
  // Rules:
  // 1. Only the requesting user — or, for an accountant/staff member,
  //    the company's single admin they are delegated to — is considered
  // 2. Company must match
  // 3. Pairing must be completed
  // 4. Latest pairing is selected
  // 5. Pairing machine_id must match connector machine_id
  // 6. API key user/company must match
  // 7. API key must not be revoked
  // 8. Connector must be live within CONNECTOR_ONLINE_WINDOW
  // 9. NEVER fallback to another user's connector, except the explicit,
  //    membership-checked delegation to the company's admin above
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
      owner.ownerUserId,
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
      delegated: owner.delegated,
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

  if (owner.delegated) {
    notifyAdminConnectorOffline(companyId, owner, actingUserId);
  }

  return null;
};