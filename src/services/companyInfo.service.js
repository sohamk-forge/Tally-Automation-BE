import db from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

/**
 * companyInfo.service.js
 * ========================
 * Reads letterhead fields (address, email, GSTIN, state, logo) from the
 * separate `company_details` table (not `companies` — that table
 * only holds name/financial year, synced by GET /api/sync/companies).
 *
 * `company_details` is populated by GET /api/sync/company-details
 * (pulls from Tally via getCompanyDetailsXML). This is a read-only
 * lookup at PDF-generation time — no live Tally call here, so PDF
 * generation stays fast and doesn't depend on the connector being
 * online at request time.
 *
 * logoDataUri is built here from company_details.logo_data /
 * logo_mime_type — persisted once via POST /api/companies/:id/logo
 * (see companyLogo.routes.js), independent of the Tally sync. It's
 * null until a logo has been uploaded, and voucherPdfRenderer.service.js
 * renders nothing in that case rather than falling back to a placeholder.
 *
 * If a company hasn't been through that sync yet, we still return
 * the company's name (from `companies`) with blank letterhead
 * fields, rather than failing the whole PDF — only a totally
 * unknown company_id throws.
 */
export async function getCompanyInfo(companyId) {
  const result = await db.query(
    `
    SELECT
      c.id,
      c.name,
      d.address,
      d.state,
      d.email,
      d.gstin,
      d.logo_data,
      d.logo_mime_type
    FROM ${DB_SCHEMA}.companies c
    LEFT JOIN ${DB_SCHEMA}.company_details d
      ON d.company_id = c.id
    WHERE c.id = $1
    LIMIT 1
    `,
    [companyId]
  );

  if (!result.rows.length) {
    throw new Error(`No company found for id=${companyId}`);
  }

  const row = result.rows[0];
  return {
    name: row.name || "",
    address: row.address || "",
    email: row.email || "",
    gstin: row.gstin || "",
    state: row.state || "",
    logoDataUri: row.logo_data
      ? `data:${row.logo_mime_type};base64,${row.logo_data.toString("base64")}`
      : null,
  };
}