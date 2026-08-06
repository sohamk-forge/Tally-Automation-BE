export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_api_keys", (table) => {
      table.timestamp("last_seen_at").nullable();
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_api_keys", (table) => {
      table.dropColumn("last_seen_at");
    });
}