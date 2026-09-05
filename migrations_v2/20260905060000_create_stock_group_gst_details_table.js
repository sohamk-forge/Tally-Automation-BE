export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("stock_group_gst_details", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("company_name");

      table.string("group_name");

      table.string("hsn_code");

      table.decimal("igst_rate", null)
        .notNullable()
        .defaultTo(0);

      table.decimal("cgst_rate", null)
        .notNullable()
        .defaultTo(0);

      table.decimal("sgst_rate", null)
        .notNullable()
        .defaultTo(0);

      table.decimal("cess_rate", null)
        .notNullable()
        .defaultTo(0);

      table.timestamps(true, true);

      table.index(["company_id"]);

      table.index(["group_name"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("stock_group_gst_details");

}
