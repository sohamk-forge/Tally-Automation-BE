import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { financialYearLabel } from "../utils/financialYears.js";

const iso = (compact) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

// Remembers the financial years a sync covered (pieces from splitIntoFinancialYears). Re-syncing a year
// widens its dates rather than shrinking them. Never throws: this is bookkeeping for the company filter and
// must not fail a sync.
export async function recordFinancialYears(companyId, pieces) {
  try {
    for (const p of pieces) {
      await pool.query(
        `
        INSERT INTO ${DB_SCHEMA}.company_financial_years (company_id, start_year, from_date, to_date, synced_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (company_id, start_year) DO UPDATE
          SET from_date = LEAST(company_financial_years.from_date, EXCLUDED.from_date),
              to_date   = GREATEST(company_financial_years.to_date, EXCLUDED.to_date),
              synced_at = NOW()
        `,
        [companyId, p.startYear, iso(p.fromDate), iso(p.toDate)]
      );
    }
  } catch (err) {
    console.error(`Could not record financial years for company ${companyId}:`, err.message);
  }
}

// Adds `financial_years` (newest first) and a `financial_year` label to company rows for the company list.
// A database that has not run the migration yet just gets the label from the stored start/end year.
export async function withFinancialYears(rows) {
  if (!rows.length) return rows;

  let byCompany = new Map();
  try {
    const { rows: fy } = await pool.query(
      `
      SELECT company_id, start_year, from_date::text AS from_date, to_date::text AS to_date
      FROM ${DB_SCHEMA}.company_financial_years
      WHERE company_id = ANY($1::int[])
      ORDER BY start_year DESC
      `,
      [rows.map((r) => r.id)]
    );
    for (const row of fy) {
      if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
      byCompany.get(row.company_id).push({
        start_year: row.start_year,
        label: financialYearLabel(row.start_year),
        from_date: row.from_date,
        to_date: row.to_date
      });
    }
  } catch (err) {
    console.error("Could not read company financial years:", err.message);
  }

  return rows.map((row) => {
    const years = byCompany.get(row.id) || [];
    const start = Number(row.financial_year_start);
    const end = Math.max(Number(row.financial_year_end) || start + 1, start + 1);
    const label = years.length
      ? years.length === 1
        ? years[0].label
        : `${years[years.length - 1].label.slice(0, 4)}-${years[0].label.slice(5)}`
      : Number.isInteger(start)
        ? `${start}-${String(end).slice(2)}`
        : null;
    return { ...row, financial_years: years, financial_year: label };
  });
}
