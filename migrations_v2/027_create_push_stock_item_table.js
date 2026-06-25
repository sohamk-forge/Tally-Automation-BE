export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("push_stock_item", (table) => {

      table.increments("id").primary();

      table.integer("company_id");

      table.string("company_name");

      table.string("item_name");

      table.string("alias_name");

      table.string("unit_name");

      table.text("description");

      table.string("hsn_code");

      table.decimal(
        "cgst_rate",
        10,
        2
      ).defaultTo(0);

      table.decimal(
        "sgst_rate",
        10,
        2
      ).defaultTo(0);

      table.decimal(
        "igst_rate",
        10,
        2
      ).defaultTo(0);

      table.string("status")
        .defaultTo("pending");

      table.text("tally_response");

      table.timestamp("created_at")
        .defaultTo(knex.fn.now());

      table.timestamp("updated_at")
        .defaultTo(knex.fn.now());

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists(
      "push_stock_item"
    );

}