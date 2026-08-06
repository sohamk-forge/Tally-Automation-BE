export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_details", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE")
        .unique();

      table.string("company_name");

      table.text("address");

      table.string("state");

      table.string("email");

      table.string("gstin");

      table.timestamp("last_synced_at");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_details");

}