export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("stock_group_summary", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("company_name");

      table.string("group_name");

      table.string("item_name");

      table.decimal("quantity", 18, 2)
        .defaultTo(0);

      table.decimal("stock_value", 18, 2)
        .defaultTo(0);

      table.timestamps(true, true);

      table.string("hsn_code");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("stock_group_summary");

}