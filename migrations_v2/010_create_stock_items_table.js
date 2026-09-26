export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("stock_items", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("tally_stock_id");

      table.string("name");

      table.string("unit");

      table.decimal("closing_balance", 18, 2)
        .defaultTo(0);

      table.bigInteger("alter_id");

      table.timestamps(true, true);

      table.string("company_name");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("stock_items");

}