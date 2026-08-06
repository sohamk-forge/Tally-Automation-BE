export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists(
      "sundry_creditors"
    );

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists(
      "sundry_debtors"
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable(
      "sundry_creditors",
      (table) => {

        table.increments("id");

      }
    );

  await knex.schema
    .withSchema("app_test")
    .createTable(
      "sundry_debtors",
      (table) => {

        table.increments("id");

      }
    );

}