import "dotenv/config";
import pool from "../src/db/index.js";
import UserRoles from "supertokens-node/recipe/userroles/index.js";
import { initSupertokens } from "../src/config/supertokens.js";

/**
 * One-off migration: imports every app_test.users row that still has a
 * bcrypt password hash (i.e. was never migrated) into the SuperTokens core,
 * preserving the hash so nobody has to reset their password. Safe to re-run
 * — already-migrated rows (supertokens_user_id set) are skipped.
 */

const importPasswordHash = async (email, passwordHash) => {
  const response = await fetch(
    `${process.env.SUPERTOKENS_CONNECTION_URI}/recipe/user/passwordhash/import`,
    {
      method: "POST",
      headers: {
        "api-key": process.env.SUPERTOKENS_API_KEY,
        "content-type": "application/json",
        rid: "emailpassword",
      },
      body: JSON.stringify({ email, passwordHash }),
    }
  );

  return response.json();
};

const run = async () => {
  initSupertokens();

  const { rows: users } = await pool.query(
    `
    SELECT id, email, password, role
    FROM app_test.users
    WHERE supertokens_user_id IS NULL
      AND password IS NOT NULL
    ORDER BY id
    `
  );

  console.log(`Found ${users.length} user(s) to migrate.`);

  let migrated = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const result = await importPasswordHash(user.email, user.password);

      if (result.status !== "OK") {
        console.error(`  [${user.email}] import failed:`, result);
        failed += 1;
        continue;
      }

      const supertokensUserId = result.user.id;
      const role = user.role || "user";

      await UserRoles.createNewRoleOrAddPermissions(role, []);
      await UserRoles.addRoleToUser("public", supertokensUserId, role);

      await pool.query(
        `
        UPDATE app_test.users
        SET supertokens_user_id = $1,
            password = NULL
        WHERE id = $2
        `,
        [supertokensUserId, user.id]
      );

      console.log(`  [${user.email}] migrated -> ${supertokensUserId}`);
      migrated += 1;
    } catch (err) {
      console.error(`  [${user.email}] error:`, err.message);
      failed += 1;
    }
  }

  console.log(`Done. Migrated ${migrated}, failed ${failed}.`);
  process.exit(failed > 0 ? 1 : 0);
};

run();
