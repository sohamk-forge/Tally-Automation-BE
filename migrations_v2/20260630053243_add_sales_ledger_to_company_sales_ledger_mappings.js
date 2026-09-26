export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("company_sales_ledger_mappings", (table) => {

      table.string("sales_ledger");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("company_sales_ledger_mappings", (table) => {

      table.dropColumn("sales_ledger");

    });

}