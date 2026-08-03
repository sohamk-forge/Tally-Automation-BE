export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("users", (table) => {

      table.boolean("has_password").notNullable().defaultTo(true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("users", (table) => {

      table.dropColumn("has_password");

    });

}
