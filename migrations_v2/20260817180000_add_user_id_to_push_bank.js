/**
 * push_bank has no user_id column, unlike contra_vouchers — which is
 * exactly what lets pushVoucher.worker.js safely re-enqueue stale pending
 * rows on startup (resolveConnectorForCompany requires knowing the acting
 * user; it must never fall back to another user's connector). Without this
 * column, a push_bank job orphaned by a backend restart between the DB
 * insert and the Redis enqueue call has no safe way to be recovered.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("push_bank", (table) => {
    table.integer("user_id").references("id").inTable("app_test.users");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("push_bank", (table) => {
    table.dropColumn("user_id");
  });
}
