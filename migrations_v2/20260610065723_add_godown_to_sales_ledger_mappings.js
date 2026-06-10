

export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_sales_ledger_mappings", (table) => {
      table.string("godown_name").defaultTo("Main Location");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_sales_ledger_mappings", (table) => {
      table.dropColumn("godown_name");
    });
}