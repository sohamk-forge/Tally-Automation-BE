export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_machines", (table) => {
    table.unique(["user_id"], "unique_user_connector");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_machines", (table) => {
    table.dropUnique(["user_id"], "unique_user_connector");
  });
}