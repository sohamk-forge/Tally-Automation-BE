/**
 * companyLogo.service.js
 * ========================
 * Persists and retrieves a company's logo, stored on the same
 * company_details row as the rest of the letterhead fields (address,
 * email, gstin, state). Uses the raw pg pool (db.query), matching the
 * rest of this codebase's DB access pattern — not Knex at runtime.
 *
 * Since company_details rows are only created by the Tally sync
 * (GET /api/sync/company-details), a company may not have a row yet
 * when the user uploads a logo. INSERT ... ON CONFLICT handles both
 * "row already exists" (update just the logo columns) and "no row yet"
 * (create a minimal row) without clobbering other synced fields.
 */

import db from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

/**
 * @param {number|string} companyId
 * @param {{ buffer: Buffer, mimeType: string, originalFilename: string }} logo
 */
export async function saveCompanyLogo(companyId, logo) {
  await db.query(
    `
    INSERT INTO ${DB_SCHEMA}.company_details (company_id, logo_data, logo_mime_type, logo_original_filename, logo_uploaded_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (company_id) DO UPDATE
      SET logo_data = EXCLUDED.logo_data,
          logo_mime_type = EXCLUDED.logo_mime_type,
          logo_original_filename = EXCLUDED.logo_original_filename,
          logo_uploaded_at = NOW()
    `,
    [companyId, logo.buffer, logo.mimeType, logo.originalFilename]
  );
}

/**
 * Returns the logo as a ready-to-embed data URI, or null if the company
 * has no logo stored yet (or no company_details row at all).
 * @param {number|string} companyId
 * @returns {Promise<string|null>}
 */
export async function getCompanyLogoDataUri(companyId) {
  const result = await db.query(
    `SELECT logo_data, logo_mime_type FROM ${DB_SCHEMA}.company_details WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );

  const row = result.rows[0];
  if (!row || !row.logo_data) return null;

  return `data:${row.logo_mime_type};base64,${row.logo_data.toString("base64")}`;
}

/**
 * Returns logo metadata only (no bytes) — for a settings page that just
 * needs to show "logo.pdf uploaded on <date>" without shipping the whole
 * image back down.
 * @param {number|string} companyId
 */
export async function getCompanyLogoMeta(companyId) {
  const result = await db.query(
    `SELECT logo_mime_type, logo_original_filename, logo_uploaded_at
     FROM ${DB_SCHEMA}.company_details WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );

  const row = result.rows[0];
  if (!row) {
    return { hasLogo: false, mimeType: null, originalFilename: null, uploadedAt: null };
  }

  return {
    hasLogo: Boolean(row.logo_mime_type),
    mimeType: row.logo_mime_type,
    originalFilename: row.logo_original_filename,
    uploadedAt: row.logo_uploaded_at,
  };
}

/**
 * Removes a company's stored logo. No-op if there's no company_details
 * row yet (nothing to clear).
 * @param {number|string} companyId
 */
export async function deleteCompanyLogo(companyId) {
  await db.query(
    `
    UPDATE ${DB_SCHEMA}.company_details
    SET logo_data = NULL, logo_mime_type = NULL, logo_original_filename = NULL, logo_uploaded_at = NULL
    WHERE company_id = $1
    `,
    [companyId]
  );
}