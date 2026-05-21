/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE app.users
    DROP CONSTRAINT users_role_check;
  `);

  await knex.raw(`
    ALTER TABLE app.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'owner', 'viewer'));
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE app.users
    DROP CONSTRAINT users_role_check;
  `);

  await knex.raw(`
    ALTER TABLE app.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'accountant', 'warehouse', 'viewer'));
  `);
};