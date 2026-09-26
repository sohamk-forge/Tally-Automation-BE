import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

export function toVendorKey(vendorName) {
  return String(vendorName || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Exact name of a ledger that exists in this company's Tally — as synced
// (all_ledger_details, the list the Review screen's pickers show) or created
// from this app and accepted by Tally but not yet picked up by a sync.
export async function findCompanyLedger(companyId, ledgerName) {
  const wanted = String(ledgerName || "").trim();
  if (!wanted) return null;

  const result = await pool.query(
    `
    SELECT TRIM(ledger_name) AS ledger_name
    FROM (
      SELECT ledger_name FROM ${DB_SCHEMA}.all_ledger_details WHERE company_id = $1
      UNION ALL
      SELECT ledger_name FROM ${DB_SCHEMA}.push_ledger WHERE company_id = $1 AND status = 'success'
    ) l
    WHERE LOWER(TRIM(ledger_name)) = LOWER($2)
    LIMIT 1
    `,
    [companyId, wanted]
  );
  return result.rows[0]?.ledger_name || null;
}

// The saved ledger for this vendor, but only while it still exists in
// Tally — a ledger deleted/renamed there falls back to the normal
// "Ledger Missing" review instead of pushing to a ledger Tally lacks.
export async function resolveMappedLedger(companyId, vendorName) {
  const key = toVendorKey(vendorName);
  if (!key) return null;

  const mapping = await pool.query(
    `SELECT ledger_name FROM ${DB_SCHEMA}.vendor_ledger_mappings WHERE company_id = $1 AND vendor_key = $2`,
    [companyId, key]
  );
  const mapped = mapping.rows[0]?.ledger_name;
  if (!mapped) return null;

  return findCompanyLedger(companyId, mapped);
}
