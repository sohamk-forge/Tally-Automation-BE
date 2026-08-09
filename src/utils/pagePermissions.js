import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// Canonical list of pages that can be individually enabled/disabled per role.
// Keep this in sync with the frontend's own copy (src/pages/Team.jsx /
// src/context/CompanyContext.jsx) — there's no shared package between the
// two repos to import this from.
//
// "team" (Team & Access) is deliberately NOT in this list — it stays
// permanently admin-only, never exposed as a toggle, so an admin can't
// accidentally hand out team/role management to a non-admin.
export const PAGE_KEYS = [
  "dashboard",
  "challans",
  "invoices",
  "sales_invoices",
  "po",
  "ledgers",
  "banking",
  "gst_recon",
  "inventory",
  "quotation",
  "sync",
];

export const EDITABLE_ROLES = ["accountant", "staff"];

// Returns { accountant: { pageKey: bool, ... }, staff: { ... } } — every
// page defaults to enabled unless an explicit override row says otherwise.
export async function getRolePermissionMatrix(companyId) {
  const result = await pool.query(
    `
    SELECT role, page_key, enabled
    FROM ${DB_SCHEMA}.company_role_permissions
    WHERE company_id = $1
    `,
    [companyId]
  );

  const matrix = {};
  for (const r of EDITABLE_ROLES) {
    matrix[r] = Object.fromEntries(PAGE_KEYS.map((k) => [k, true]));
  }

  for (const row of result.rows) {
    if (matrix[row.role]) {
      matrix[row.role][row.page_key] = row.enabled;
    }
  }

  return matrix;
}

// Returns the list of page keys this specific role can currently see.
// Admin isn't handled here — callers should treat admin as "all pages,
// always" without consulting this table at all.
export async function getEnabledPagesForRole(companyId, role) {
  if (!EDITABLE_ROLES.includes(role)) {
    return [...PAGE_KEYS];
  }

  const result = await pool.query(
    `
    SELECT page_key, enabled
    FROM ${DB_SCHEMA}.company_role_permissions
    WHERE company_id = $1 AND role = $2
    `,
    [companyId, role]
  );

  const disabled = new Set(
    result.rows.filter((r) => r.enabled === false).map((r) => r.page_key)
  );

  return PAGE_KEYS.filter((k) => !disabled.has(k));
}
