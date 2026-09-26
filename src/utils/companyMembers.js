import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// Returns the caller's role ('admin' | 'accountant' | 'staff') for a given
// company, or null if they aren't a member at all.
export async function getCompanyMemberRole(userId, companyId) {
  const result = await pool.query(
    `
    SELECT role
    FROM ${DB_SCHEMA}.company_members
    WHERE user_id = $1
      AND company_id = $2
    LIMIT 1
    `,
    [userId, companyId]
  );

  return result.rows[0]?.role ?? null;
}

const STAFF_SOFT_CAP = 3;

// Checks whether `role` is available to assign to `userId` on `companyId` —
// admin/accountant are single-seat roles (excluding userId itself, so
// re-saving a user's own current role is never blocked), staff has a soft
// cap. Returns { available: true } or { available: false, reason, ... }.
export async function checkSeatAvailable(companyId, role, userId, dbClient = pool) {
  if (role === "admin" || role === "accountant") {
    const seatResult = await dbClient.query(
      `
      SELECT u.email
      FROM ${DB_SCHEMA}.company_members cm
      JOIN ${DB_SCHEMA}.users u ON u.id = cm.user_id
      WHERE cm.company_id = $1
        AND cm.role = $2
        AND cm.user_id != $3
      LIMIT 1
      `,
      [companyId, role, userId]
    );

    if (seatResult.rows.length > 0) {
      return { available: false, reason: "seat_taken", takenBy: seatResult.rows[0].email };
    }

    return { available: true };
  }

  const countResult = await dbClient.query(
    `
    SELECT count(*)::int AS count
    FROM ${DB_SCHEMA}.company_members
    WHERE company_id = $1
      AND role = 'staff'
      AND user_id != $2
    `,
    [companyId, userId]
  );

  if (countResult.rows[0].count >= STAFF_SOFT_CAP) {
    return { available: false, reason: "staff_limit_reached" };
  }

  return { available: true };
}
