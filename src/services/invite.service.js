import crypto from "crypto";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { checkSeatAvailable } from "../utils/companyMembers.js";

/**
 * Company access is gated by connector_pairing_tokens (user_id + company_id +
 * is_used=true), not the vestigial user_companies table — see the scoping
 * note in companies.routes.js. Granting an invitee the inviter's access means
 * cloning the inviter's used pairing-token rows for the invitee.
 */
export const VALID_ROLES = ["admin", "accountant", "staff"];

export class InviteValidationError extends Error {}

export const createInvite = async (invitedByUserId, email, role = "staff") => {
  const inviterResult = await pool.query(
    `SELECT email FROM ${DB_SCHEMA}.users WHERE id = $1 LIMIT 1`,
    [invitedByUserId]
  );
  const inviterEmail = inviterResult.rows[0]?.email;

  if (inviterEmail && inviterEmail.trim().toLowerCase() === email.trim().toLowerCase()) {
    throw new InviteValidationError("You can't invite your own email address");
  }

  // An email that's already an approved member of any company (most likely
  // the inviter's own company, re-invited by mistake) shouldn't get a
  // second, redundant pending invite — that's exactly what let a stray
  // self-invite block the inviter's own access via PendingApprovalGate.
  const alreadyMemberResult = await pool.query(
    `
    SELECT 1
    FROM ${DB_SCHEMA}.users u
    JOIN ${DB_SCHEMA}.company_members cm ON cm.user_id = u.id
    WHERE lower(trim(u.email)) = lower(trim($1))
    LIMIT 1
    `,
    [email]
  );
  if (alreadyMemberResult.rows.length > 0) {
    throw new InviteValidationError("This email already has access to a company");
  }

  const result = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.invites (email, invited_by_user_id, status, role)
    VALUES ($1, $2, 'invited', $3)
    RETURNING id, email, status, role, created_at
    `,
    [email, invitedByUserId, role]
  );

  return result.rows[0];
};

/**
 * Called from the Passwordless consumeCodePOST override once an invited
 * user successfully logs in via their magic link. Moves the invite from
 * "invited" to "pending_approval" — access is still withheld until the
 * inviter explicitly approves it.
 */
export const markInviteAccepted = async (supertokensUserId, email) => {
  // Looked up by email, not supertokens_user_id: an invitee who already had
  // an account under a different SuperTokens recipe (e.g. EmailPassword)
  // keeps their original local profile row, which won't carry this new
  // Passwordless recipe user's id.
  const userResult = await pool.query(
    `SELECT id FROM ${DB_SCHEMA}.users WHERE email = $1 LIMIT 1`,
    [email]
  );
  const inviteeUserId = userResult.rows[0]?.id ?? null;
  if (!inviteeUserId) return;

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.invites
    SET status = 'pending_approval',
        supertokens_user_id = $1,
        invitee_user_id = $2,
        updated_at = now()
    WHERE email = $3
      AND status = 'invited'
    `,
    [supertokensUserId, inviteeUserId, email]
  );
};

export const listInvitesForUser = async (invitedByUserId) => {
  const result = await pool.query(
    `
    SELECT id, email, status, role, invitee_user_id, created_at, updated_at
    FROM ${DB_SCHEMA}.invites
    WHERE invited_by_user_id = $1
    ORDER BY created_at DESC
    `,
    [invitedByUserId]
  );

  return result.rows;
};

/**
 * Returns the invite currently blocking this user from real access, if any
 * — used to show a "waiting for approval" screen instead of the normal
 * dashboard shell. A user can only ever be genuinely blocked by one invite
 * at a time (the one that brought them into the app), so the most recent
 * pending_approval row targeting them is enough.
 */
export const getPendingInviteForUser = async (userId) => {
  // Only blocks a user who has NO approved access anywhere yet — a stray
  // pending invite (e.g. a duplicate/self-invite, or an invite to a second
  // company) must never lock out a user who already has a real,
  // approved company_members role somewhere else.
  const result = await pool.query(
    `
    SELECT
      i.id,
      i.role,
      i.created_at,
      u.email AS inviter_email,
      u.first_name AS inviter_first_name,
      u.last_name AS inviter_last_name
    FROM ${DB_SCHEMA}.invites i
    JOIN ${DB_SCHEMA}.users u ON u.id = i.invited_by_user_id
    WHERE i.invitee_user_id = $1
      AND i.status = 'pending_approval'
      AND NOT EXISTS (
        SELECT 1 FROM ${DB_SCHEMA}.company_members cm WHERE cm.user_id = $1
      )
    ORDER BY i.created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

/**
 * Approves a pending invite: clones every company the inviter currently has
 * access to (a used connector_pairing_tokens row) onto the invitee, then
 * marks the invite approved. Only the original inviter may approve.
 */
export const approveInvite = async (inviteId, approverUserId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inviteResult = await client.query(
      `
      SELECT id, invited_by_user_id, invitee_user_id, status, role
      FROM ${DB_SCHEMA}.invites
      WHERE id = $1
      FOR UPDATE
      `,
      [inviteId]
    );

    const invite = inviteResult.rows[0];
    if (!invite) {
      await client.query("ROLLBACK");
      return { error: "not_found" };
    }
    if (invite.invited_by_user_id !== approverUserId) {
      await client.query("ROLLBACK");
      return { error: "forbidden" };
    }
    if (invite.status !== "pending_approval") {
      await client.query("ROLLBACK");
      return { error: "invalid_status" };
    }
    if (!invite.invitee_user_id) {
      await client.query("ROLLBACK");
      return { error: "invitee_not_signed_in" };
    }

    const role = invite.role || "staff";

    const pairingResult = await client.query(
      `
      SELECT company_id
      FROM ${DB_SCHEMA}.connector_pairing_tokens
      WHERE user_id = $1
        AND is_used = TRUE
        AND company_id IS NOT NULL
      `,
      [invite.invited_by_user_id]
    );

    // Check every company this invite would grant BEFORE mutating anything —
    // a partial grant (some companies succeed, one fails) would leave the
    // invitee with confusing, inconsistent access.
    for (const { company_id } of pairingResult.rows) {
      const seatCheck = await checkSeatAvailable(company_id, role, invite.invitee_user_id, client);

      if (!seatCheck.available) {
        await client.query("ROLLBACK");
        return {
          error: seatCheck.reason,
          role,
          companyId: company_id,
          takenBy: seatCheck.takenBy
        };
      }
    }

    for (const { company_id } of pairingResult.rows) {
      const token = "INVITE-" + crypto.randomBytes(8).toString("hex").toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

      await client.query(
        `
        INSERT INTO ${DB_SCHEMA}.connector_pairing_tokens
        (id, user_id, company_id, token, expires_at, is_used, invite_id)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE, $5)
        ON CONFLICT DO NOTHING
        `,
        [invite.invitee_user_id, company_id, token, expiresAt, inviteId]
      );

      await client.query(
        `
        INSERT INTO ${DB_SCHEMA}.company_members (user_id, company_id, role, invited_by_user_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role
        `,
        [invite.invitee_user_id, company_id, role, invite.invited_by_user_id]
      );
    }

    await client.query(
      `
      UPDATE ${DB_SCHEMA}.invites
      SET status = 'approved', updated_at = now()
      WHERE id = $1
      `,
      [inviteId]
    );

    await client.query("COMMIT");

    return { companiesGranted: pairingResult.rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Revokes an invite at any active stage. For an approved invite this deletes
 * exactly the connector_pairing_tokens rows that invite created (tagged via
 * invite_id at approval time) — never anything the invitee has independent
 * of this invite. Only the original inviter may revoke.
 */
export const revokeInvite = async (inviteId, requesterUserId) => {
  const inviteResult = await pool.query(
    `
    SELECT id, invited_by_user_id, invitee_user_id, status
    FROM ${DB_SCHEMA}.invites
    WHERE id = $1
    `,
    [inviteId]
  );

  const invite = inviteResult.rows[0];
  if (!invite) {
    return { error: "not_found" };
  }
  if (invite.invited_by_user_id !== requesterUserId) {
    return { error: "forbidden" };
  }
  if (!["invited", "pending_approval", "approved"].includes(invite.status)) {
    return { error: "invalid_status" };
  }

  const revokedResult = await pool.query(
    `DELETE FROM ${DB_SCHEMA}.connector_pairing_tokens WHERE invite_id = $1 RETURNING company_id`,
    [inviteId]
  );

  // Also drop this invite's role grant for the same companies — otherwise a
  // revoked admin/accountant invite would keep occupying that role's seat
  // (blocking a new invite for the same role) even though their actual data
  // access was just revoked above.
  if (invite.invitee_user_id && revokedResult.rows.length > 0) {
    const companyIds = revokedResult.rows.map((row) => row.company_id);

    await pool.query(
      `
      DELETE FROM ${DB_SCHEMA}.company_members
      WHERE user_id = $1
        AND company_id = ANY($2::int[])
      `,
      [invite.invitee_user_id, companyIds]
    );
  }

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.invites
    SET status = 'revoked', updated_at = now()
    WHERE id = $1
    `,
    [inviteId]
  );

  return { companiesRevoked: revokedResult.rowCount };
};
