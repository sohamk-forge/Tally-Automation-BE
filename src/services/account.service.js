import supertokens from "supertokens-node";
import EmailPassword from "supertokens-node/recipe/emailpassword/index.js";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

export const getHasPassword = async (localUserId) => {
  const result = await pool.query(
    `SELECT has_password FROM ${DB_SCHEMA}.users WHERE id = $1`,
    [localUserId]
  );
  return result.rows[0]?.has_password ?? true;
};

/**
 * Invited teammates first log in via a Passwordless magic link, which has
 * no password. This gives them one by either creating a brand-new
 * EmailPassword recipe user (first time) or updating the password on an
 * EmailPassword recipe user that already existed for this email (they had
 * an account before being invited). Either way, app_test.users.supertokens_user_id
 * is repointed at the EmailPassword identity — that's what they'll sign in
 * with from now on.
 */
export const setPasswordForUser = async (localUserId, email, password) => {
  const existingUsers = await supertokens.listUsersByAccountInfo("public", { email });
  const emailPasswordUser = existingUsers.find((u) =>
    u.loginMethods.some((lm) => lm.recipeId === "emailpassword")
  );

  let emailPasswordRecipeUserId;

  if (emailPasswordUser) {
    const recipeUserId = supertokens.convertToRecipeUserId(emailPasswordUser.id);
    const result = await EmailPassword.updateEmailOrPassword({ recipeUserId, password });
    if (result.status !== "OK") {
      return { error: result.status };
    }
    emailPasswordRecipeUserId = emailPasswordUser.id;
  } else {
    const result = await EmailPassword.signUp("public", email, password);
    if (result.status !== "OK") {
      return { error: result.status };
    }
    emailPasswordRecipeUserId = result.user.id;
  }

  await pool.query(
    `
    UPDATE ${DB_SCHEMA}.users
    SET supertokens_user_id = $1, has_password = TRUE
    WHERE id = $2
    `,
    [emailPasswordRecipeUserId, localUserId]
  );

  return { ok: true };
};
