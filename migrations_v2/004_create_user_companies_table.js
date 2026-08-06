export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("user_companies", (table) => {

      table.increments("id").primary();

      table.integer("user_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.users")
        .onDelete("CASCADE");

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("user_companies");

}