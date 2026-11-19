// A company's profile, read once from what the first sync saved: is it GST, and how each
// voucher type is numbered. Every push and document asks here instead of working it out
// on its own. The rules live in companyProfileRules.js.
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { buildProfile, gstFromDetails, checkPushReadiness, readinessMessage } from "./companyProfileRules.js";

async function loadDetails(companyId) {
  const { rows } = await pool.query(
    `SELECT gstin, gst_registration_type FROM ${DB_SCHEMA}.company_details WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

// GST facts only (one small query) for callers that don't care about numbering.
export async function getCompanyGst(companyId) {
  return gstFromDetails(await loadDetails(companyId));
}

export async function getCompanyProfile(companyId) {
  const [details, types] = await Promise.all([
    loadDetails(companyId),
    pool.query(
      `SELECT name, base_type, numbering_method
         FROM ${DB_SCHEMA}.voucher_types
        WHERE company_id = $1 AND is_active = true`,
      [companyId]
    )
  ]);
  return buildProfile({ details, voucherTypes: types.rows });
}

// Is the company ready for a push of this voucher type? { ok, message, problems }.
// message is ready to show the user when ok is false.
export async function checkCompanyReady(companyId, { typeName, needsGst = false, companyName } = {}) {
  const profile = await getCompanyProfile(companyId);
  const { ok, problems } = checkPushReadiness(profile, { typeName, needsGst });
  return { ok, problems, message: ok ? null : readinessMessage(companyName, problems) };
}
