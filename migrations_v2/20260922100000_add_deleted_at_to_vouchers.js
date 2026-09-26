/**
 * Backs the voucher-sync soft-delete: a voucher removed from Tally between
 * syncs should stop showing up, without physically deleting sync history.
 * The partial index keeps every read site's added `deleted_at IS NULL`
 * filter on the same fast path as the existing (company_id, voucher_date)
 * queries.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.timestamp("deleted_at", { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE INDEX idx_app_test_vouchers_company_date_active
    ON app_test.vouchers (company_id, voucher_date)
    WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.idx_app_test_vouchers_company_date_active`);

  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.dropColumn("deleted_at");
  });
}
