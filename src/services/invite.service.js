import crypto from "crypto";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

/**
 * Company access is gated by connector_pairing_tokens (user_id + company_id +
 * is_used=true), not the vestigial user_companies table — see the scoping
 * note in companies.routes.js. Granting an invitee the inviter's access means
 * cloning the inviter's used pairing-token rows for the invitee.
 */
export const createInvite = async (invitedByUserId, email) => {
  const result = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.invites (email, invited_by_user_id, status)
    VALUES ($1, $2, 'invited')
    RETURNING id, email, status, created_at
    `,
    [email, invitedByUserId]
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
    SELECT id, email, status, invitee_user_id, created_at, updated_at
    FROM ${DB_SCHEMA}.invites
    WHERE invited_by_user_id = $1
    ORDER BY created_at DESC
    `,
    [invitedByUserId]
  );

  return result.rows;
};

/**
 * Approves a pending invite: clones every company the inviter currently has
 * access to (a used connector_pairing_tokens row) onto the invitee, then
 * marks the invite approved. Only the original inviter may approve.
 */
export const approveInvite = async (inviteId, approverUserId) => {
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
  if (invite.invited_by_user_id !== approverUserId) {
    return { error: "forbidden" };
  }
  if (invite.status !== "pending_approval") {
    return { error: "invalid_status" };
  }
  if (!invite.invitee_user_id) {
    return { error: "invitee_not_signed_in" };
  }

  const pairingResult = await pool.query(
    `
    SELECT company_id
    FROM ${DB_SCHEMA}.connector_pairing_tokens
    WHERE user_id = $1
      AND is_used = TRUE
      AND company_id IS NOT NULL
    `,
    [invite.invited_by_user_id]
  );

  for (const { company_id } of pairingResult.rows) {
    const token = "INVITE-" + crypto.randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.connector_pairing_tokens
      (id, user_id, company_id, token, expires_at, is_used, invite_id)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE, $5)
      ON CONFLICT DO NOTHING
      `,
      [invite.invitee_user_id, company_id, token, expiresAt, inviteId]
    );
  }

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.invites
    SET status = 'approved', updated_at = now()
    WHERE id = $1
    `,
    [inviteId]
  );

  return { companiesGranted: pairingResult.rows.length };
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
    SELECT id, invited_by_user_id, status
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
    `DELETE FROM ${DB_SCHEMA}.connector_pairing_tokens WHERE invite_id = $1`,
    [inviteId]
  );

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
