export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_ledger_mappings", (table) => {
      table.string("discount_ledger");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_ledger_mappings", (table) => {
      table.dropColumn("discount_ledger");
    });
}
