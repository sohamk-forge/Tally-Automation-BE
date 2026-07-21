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
export const ensureLocalUserProfile = async (supertokensUserId, email, role = "user", profile = {}) => {
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
      phone
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6
    )
    ON CONFLICT (supertokens_user_id) DO NOTHING
    RETURNING id
    `,
    [email, supertokensUserId, role, firstName, lastName, phone]
  );

  return result.rows[0]?.id ?? null;
};
