export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_machines", (table) => {

      table.timestamp("jwt_expires_at");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_machines", (table) => {

      table.dropColumn("jwt_expires_at");

    });

}