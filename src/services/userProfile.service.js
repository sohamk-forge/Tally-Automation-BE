import UserRoles from "supertokens-node/recipe/userroles/index.js";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
/**
 * app_test.users is the app's profile table (phone, name, and the FK
 * relationships job_logs/connector_* already have to users.id) — SuperTokens
 * owns credentials, this keeps a linked profile row in sync with it.
 * Called right after a SuperTokens sign up so every new session has a
 * corresponding local numeric user id available (see getLocalUserId.js).
 */
export const ensureLocalUserProfile = async (supertokensUserId, email, role = "user", profile = {}, hasPassword = true, emailVerified = true) => {
  await UserRoles.createNewRoleOrAddPermissions(role, []);
  await UserRoles.addRoleToUser("public", supertokensUserId, role);

  const { firstName = null, lastName = null, phone = null } = profile;

  const result = await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.users
    (
      email,
      supertokens_user_id,
      role,
      first_name,
      last_name,
      phone,
      has_password,
      email_verified
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8
    )
    ON CONFLICT (email) DO NOTHING
    RETURNING id
    `,
    [email, supertokensUserId, role, firstName, lastName, phone, hasPassword, emailVerified]
  );

  if (result.rows[0]) return result.rows[0].id;

  // Someone can already have a local profile under a different SuperTokens
  // recipe (e.g. signed up with EmailPassword, then invited via the
  // Passwordless magic-link flow — two different recipe user ids, same
  // email). Email is the real identity anchor here, so reuse that row
  // rather than erroring on the email uniqueness constraint.
  const existing = await pool.query(
    `SELECT id FROM ${DB_SCHEMA}.users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return existing.rows[0]?.id ?? null;
};
