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

// A connector sends a heartbeat (POST /api/connector/ping) every second, on its own timer that keeps
// running while it is busy with a slow Tally job. So "online" means: heard from within the last few
// beats. 3 s = 3 missed beats: absorbs normal network jitter yet shows an offline connector within
// seconds. On a slow or lossy link, raise it (CONNECTOR_ONLINE_WINDOW_SECONDS) if the badge flaps. Connector builds from before the heartbeat existed only report between jobs: they
// would look offline during long Tally jobs, so they need updating. CONNECTOR_ONLINE_WINDOW_SECONDS
// overrides it (the old value was 60).
export const CONNECTOR_ONLINE_WINDOW = `${Number(process.env.CONNECTOR_ONLINE_WINDOW_SECONDS) || 3} seconds`;

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
// A Tally check older than this is no longer evidence either way (the connector reports it with every
// 1-second heartbeat, so 3 s means it stopped reporting - e.g. an older connector build).
export const TALLY_STATUS_FRESH_MS = (Number(process.env.TALLY_STATUS_FRESH_SECONDS) || 3) * 1000;

// What the connector last reported about Tally on its own machine:
//   tally_connected true  -> Tally answered on its port
//   tally_connected false -> connector is up but Tally did not answer
//   tally_connected null  -> unknown (never reported, or report too old)
// connector_api_keys.tally_company holds either the plain name of the company open in Tally (older
// connectors) or JSON {"active": name|null, "loaded": [names]} when the connector reports every loaded company.
const parseStoredCompany = (value) => {
  if (!value) return { tally_company: null, tally_companies: null };
  if (value.startsWith("{")) {
    try {
      const o = JSON.parse(value);
      const loaded = Array.isArray(o.loaded) ? o.loaded.filter((n) => typeof n === "string" && n) : null;
      return { tally_company: o.active || null, tally_companies: loaded?.length ? loaded : null };
    } catch {
      /* not JSON after all: fall through and treat as a plain name */
    }
  }
  return { tally_company: value, tally_companies: null };
};

// Never throws — a status badge must not break the routes that show it.
export const getTallyStatusForKey = async (apiKeyId) => {
  const unknown = { tally_connected: null, tally_checked_at: null, tally_licensed: null, tally_licence_checked_at: null, tally_company: null, tally_companies: null };
  if (!apiKeyId) return unknown;

  // The licence and company columns came later: on a database that has not run those migrations yet,
  // read the rest without them instead of losing the Tally up/down status as well.
  const read = (withLicence, withCompany) =>
    pool.query(
      `
      SELECT tally_connected,
             tally_checked_at,${withLicence ? "\n             tally_licensed,\n             tally_licence_checked_at," : ""}${withCompany ? "\n             tally_company," : ""}
             EXTRACT(EPOCH FROM (NOW() - tally_checked_at)) * 1000 AS age_ms
      FROM ${DB_SCHEMA}.connector_api_keys
      WHERE id = $1
      `,
      [apiKeyId]
    );

  try {
    const result = await read(true, true)
      .catch((err) => {
        if (err.code !== "42703") throw err; // 42703 = column does not exist
        return read(true, false);
      })
      .catch((err) => {
        if (err.code !== "42703") throw err;
        return read(false, false);
      });

    const row = result.rows[0];
    if (!row || row.tally_connected === null || row.tally_checked_at === null) return unknown;

    const fresh = Number(row.age_ms) <= TALLY_STATUS_FRESH_MS;
    return {
      tally_connected: fresh ? row.tally_connected : null,
      tally_checked_at: row.tally_checked_at,
      // Licence is checked at sync start and at pairing, not continuously: show the last answer while
      // Tally itself is reporting in and up, with the time it was asked.
      tally_licensed: fresh && row.tally_connected === true ? (row.tally_licensed ?? null) : null,
      tally_licence_checked_at: fresh && row.tally_connected === true ? (row.tally_licence_checked_at ?? null) : null,
      // The company open in Tally and every company loaded in it, only while Tally is reporting in and up
      // (same freshness as the status).
      ...(fresh && row.tally_connected === true
        ? parseStoredCompany(row.tally_company)
        : { tally_company: null, tally_companies: null })
    };
  } catch (err) {
    console.error("Tally status lookup failed:", err.message);
    return unknown;
  }
};

// Tally company names compared the way a person would: case, extra spaces and the & / "and" spelling aside.
export const normalizeCompanyName = (name) =>
  String(name ?? "").toLowerCase().replace(/&/g, " and ").replace(/\s+/g, " ").trim();

// true / false = the selected company is / is not the one open in Tally; null = cannot tell.
export const isCompanyOpenInTally = (selectedName, openName) => {
  if (!selectedName || !openName) return null;
  return normalizeCompanyName(selectedName) === normalizeCompanyName(openName);
};

// Is the company selected on the website loaded in TallyPrime? true / false, or null when it cannot
// be told. A connector that reports every loaded company is matched against that list (any loaded
// company can be worked on); an older one only reports the active company, which is compared instead.
// `tallyStatus` is getTallyStatusForKey().
export const getCompanyOpenState = async (companyId, tallyStatus) => {
  const loaded = tallyStatus?.tally_companies;
  const hasList = Array.isArray(loaded) && loaded.length > 0;
  if (!companyId || (!hasList && !tallyStatus?.tally_company)) return null;
  const co = await pool.query(`SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`, [companyId]);
  const name = co.rows[0]?.name;
  if (hasList) return name ? loaded.some((n) => isCompanyOpenInTally(name, n) === true) : null;
  return isCompanyOpenInTally(name, tallyStatus.tally_company);
};

// The connector device that is online for this user (scoped to one company
// when given — the same check the pushes use), or null when it is offline.
export const findLiveConnectorKey = async (userId, companyId = null) => {
  if (companyId) {
    const live = await resolveConnectorForCompany(companyId, userId);
    return live
      ? { api_key_id: live.api_key_id, machine_id: live.machine_id, last_seen_at: live.last_seen_at }
      : null;
  }

  const result = await pool.query(
    `
    SELECT id AS api_key_id, machine_id, last_seen_at
    FROM ${DB_SCHEMA}.connector_api_keys
    WHERE user_id = $1
      AND revoked_at IS NULL
      AND last_seen_at >= NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'
    ORDER BY last_seen_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
};
