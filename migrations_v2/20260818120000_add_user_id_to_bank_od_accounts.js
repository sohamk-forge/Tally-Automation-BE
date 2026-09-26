/**
 * Same gap as push_bank (see 20260817180000_add_user_id_to_push_bank.js) —
 * bank_od_accounts has no user_id, so a row orphaned by a backend restart
 * between insert and enqueue has no safe way to be recovered on startup.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("bank_od_accounts", (table) => {
    table.integer("user_id").references("id").inTable("app_test.users");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("bank_od_accounts", (table) => {
    table.dropColumn("user_id");
  });
}
