export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("users", (table) => {

      table.string("password").nullable().alter();

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("users", (table) => {

      table.string("password").notNullable().alter();

    });

}
