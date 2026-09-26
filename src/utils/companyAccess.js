import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

export function validateCompanyId(companyId) {
  const id = Number(companyId);
  return !id || isNaN(id) ? null : id;
}

// Company access lives in connector_pairing_tokens (user_id + company_id +
// is_used=TRUE; invitees get cloned rows) — the old user_companies table is
// vestigial and no longer kept in sync. For request handlers prefer the
// helpers in middleware/companyAccess.middleware.js, which cache per request.
export async function checkCompanyAccess(userId, companyId) {
  const result = await pool.query(
    `SELECT 1 FROM ${DB_SCHEMA}.connector_pairing_tokens
     WHERE user_id = $1 AND company_id = $2 AND is_used = TRUE
     LIMIT 1`,
    [userId, companyId]
  );
  return result.rows.length > 0;
}

export default {
  checkCompanyAccess,
  validateCompanyId
};
