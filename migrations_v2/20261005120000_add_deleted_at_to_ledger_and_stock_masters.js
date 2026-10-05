/**
 * Backs the ledger / stock-item sync soft-delete: a master removed from
 * Tally between syncs used to stay in all_ledger_details /
 * stock_group_summary forever (both syncs only ever insert/update), so the
 * pickers kept offering it and pre-push validation kept passing it — only
 * for Tally to reject the voucher with "Ledger/Stock Item 'X' does not
 * exist!", one master per push. Same approach as vouchers.deleted_at.
 * The partial indexes keep the read sites' added `deleted_at IS NULL`
 * filter on the existing company_id fast path.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("all_ledger_details", (table) => {
    table.timestamp("deleted_at", { useTz: true }).nullable();
  });

  await knex.schema.withSchema("app_test").alterTable("stock_group_summary", (table) => {
    table.timestamp("deleted_at", { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE INDEX idx_app_test_all_ledger_details_company_active
    ON app_test.all_ledger_details (company_id)
    WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX idx_app_test_stock_group_summary_company_active
    ON app_test.stock_group_summary (company_id)
    WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.idx_app_test_stock_group_summary_company_active`);
  await knex.raw(`DROP INDEX IF EXISTS app_test.idx_app_test_all_ledger_details_company_active`);

  await knex.schema.withSchema("app_test").alterTable("stock_group_summary", (table) => {
    table.dropColumn("deleted_at");
  });

  await knex.schema.withSchema("app_test").alterTable("all_ledger_details", (table) => {
    table.dropColumn("deleted_at");
  });
}
