export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("companies", (table) => {
      table.dropUnique(["name"], "companies_name_unique");
    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("companies", (table) => {
      table.unique(["name"], "companies_name_unique");
    });

}
