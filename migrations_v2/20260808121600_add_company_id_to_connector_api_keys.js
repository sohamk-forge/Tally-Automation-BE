export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_api_keys", (table) => {

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_api_keys", (table) => {
      table.dropColumn("company_id");
    });

}
