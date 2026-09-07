/**
 * src/services/site.service.js
 *
 * Backs the "Select Site" dropdown on the challan form. A site belongs to a
 * customer (Tally ledger name string, since there is no customers table),
 * and is created inline ("+ Create new site") from the frontend.
 */

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: listSitesForCustomer
// ─────────────────────────────────────────────────────────────────────────────

export async function listSitesForCustomer(companyId, customerName) {
  if (!customerName) return [];

  const res = await pool.query(
    `SELECT id, customer_name, site_name, created_at
     FROM ${DB_SCHEMA}.customer_sites
     WHERE company_id = $1 AND customer_name = $2
     ORDER BY site_name ASC`,
    [companyId, customerName]
  );
  return res.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createSite
// ─────────────────────────────────────────────────────────────────────────────

export async function createSite(companyId, { customer_name, site_name }) {
  const cleanCustomer = String(customer_name || "").trim();
  const cleanSite = String(site_name || "").trim();

  if (!cleanCustomer) throw new Error("customer_name is required");
  if (!cleanSite) throw new Error("site_name is required");

  const res = await pool.query(
    `INSERT INTO ${DB_SCHEMA}.customer_sites (company_id, customer_name, site_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, customer_name, site_name) DO UPDATE
       SET site_name = EXCLUDED.site_name
     RETURNING id, customer_name, site_name, created_at`,
    [companyId, cleanCustomer, cleanSite]
  );

  return res.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getSiteById
// Used by GET /api/v1/site/:id, and internally by challan.service.js to
// validate site_id belongs to the same company before attaching it to a
// challan.
// ─────────────────────────────────────────────────────────────────────────────

export async function getSiteById(companyId, siteId) {
  if (!siteId) return null;

  const res = await pool.query(
    `SELECT id, customer_name, site_name, created_at
     FROM ${DB_SCHEMA}.customer_sites
     WHERE id = $1 AND company_id = $2`,
    [siteId, companyId]
  );

  return res.rows[0] || null;
}
