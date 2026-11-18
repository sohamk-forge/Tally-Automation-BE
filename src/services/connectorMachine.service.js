import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

/**
 * Saves the machine record when a connector pairs. The connector app used to write connector_machines itself,
 * which meant every installed copy carried database credentials. It now sends the details with the pairing call
 * and this does the write, so the desktop app needs no database access at all.
 *
 * connector_machines has a unique user_id and a unique machine_id, so this tries, in order:
 *   1. the row this user already has,
 *   2. the row this machine already has (a placeholder, or another user's),
 *   3. a new row.
 * fromYear / toYear are optional: an older connector that does not send them leaves the saved years untouched.
 * Display data only (the companies list and the connector's "already connected" check read it), so a failure is
 * logged and never allowed to fail the pairing.
 */
export async function recordPairedMachine({ userId, companyId, machineId, companyName, fromYear, toYear }) {
  const years = [Number.isInteger(fromYear) ? fromYear : null, Number.isInteger(toYear) ? toYear : null];

  try {
    let result = await pool.query(
      `
      UPDATE ${DB_SCHEMA}.connector_machines
      SET machine_id = $2, machine_name = $2, company_name = $3, company_id = $4,
          from_year = COALESCE($5, from_year), to_year = COALESCE($6, to_year),
          tally_connected = TRUE, last_seen = NOW(), updated_at = NOW()
      WHERE user_id = $1
      `,
      [userId, machineId, companyName, companyId, ...years]
    );

    if (result.rowCount === 0) {
      result = await pool.query(
        `
        UPDATE ${DB_SCHEMA}.connector_machines
        SET user_id = $1, company_name = $3, company_id = $4,
            from_year = COALESCE($5, from_year), to_year = COALESCE($6, to_year),
            tally_connected = TRUE, last_seen = NOW(), updated_at = NOW()
        WHERE machine_id = $2
        `,
        [userId, machineId, companyName, companyId, ...years]
      );
    }

    if (result.rowCount === 0) {
      await pool.query(
        `
        INSERT INTO ${DB_SCHEMA}.connector_machines
          (user_id, machine_id, machine_name, guid, company_name, company_id, from_year, to_year,
           tally_connected, last_seen, created_at, updated_at)
        VALUES
          ($1, $2, $2, md5(random()::text || clock_timestamp()::text), $3, $4, $5, $6,
           TRUE, NOW(), NOW(), NOW())
        `,
        [userId, machineId, companyName, companyId, ...years]
      );
    }
  } catch (err) {
    console.error("connector_machines save failed (non-fatal):", err.message);
  }
}
