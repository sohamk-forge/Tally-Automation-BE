export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_purchase_sales_ledgers", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("ledger_name").notNullable();

      table.string("parent_group");

      table.string("ledger_type"); // PURCHASE or SALES

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_purchase_sales_ledgers");

}