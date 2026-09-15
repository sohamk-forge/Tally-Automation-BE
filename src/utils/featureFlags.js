import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// Opt-in add-on gating — the counterpart to pagePermissions.js's opt-OUT
// model. A company with no row here for a given feature_key simply does not
// have it; there is no "everyone gets it unless disabled" default, because
// these are paid add-ons sold to one client at a time (see
// company_feature_flags migration for the full rationale).
export async function isFeatureEnabled(companyId, featureKey) {
  if (!companyId || !featureKey) return false;

  const result = await pool.query(
    `
    SELECT enabled
    FROM ${DB_SCHEMA}.company_feature_flags
    WHERE company_id = $1 AND feature_key = $2
    LIMIT 1
    `,
    [companyId, featureKey]
  );

  return result.rows.length > 0 && result.rows[0].enabled === true;
}

// Every add-on feature_key this company is entitled to — the FE reads this
// (piggybacked onto GET /companies/:id/my-role, alongside enabledPages) to
// decide whether to show an add-on's nav item/page at all. A company with
// no rows gets an empty array, same "opt-in, not opt-out" default as
// isFeatureEnabled above.
export async function getEnabledFeatureKeys(companyId) {
  if (!companyId) return [];

  const result = await pool.query(
    `
    SELECT feature_key
    FROM ${DB_SCHEMA}.company_feature_flags
    WHERE company_id = $1 AND enabled = TRUE
    `,
    [companyId]
  );

  return result.rows.map((r) => r.feature_key);
}

// Small Express helper for routes that already know companyId at the point
// they'd call this — not wired as blanket middleware, since companyId here
// is resolved per-route (body/query/params) the same way checkCompanyAccess
// is used elsewhere in this codebase, not from a single central middleware.
export async function requireFeature(companyId, featureKey, res) {
  const enabled = await isFeatureEnabled(companyId, featureKey);

  if (!enabled) {
    res.status(403).json({
      status: "error",
      message: `This feature is not enabled for this company: ${featureKey}`
    });
    return false;
  }

  return true;
}
