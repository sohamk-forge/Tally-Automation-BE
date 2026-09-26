/**
 * Hard 30-day expiry for connector API keys — /pair sets this on every new
 * key (see connectorAuth.routes.js), never refreshed by activity. Nullable
 * since it's meaningless for whatever pre-existing rows predate this column.
 */
export function up(knex) {
  return knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.timestamp("expires_at", { useTz: true }).nullable();
  });
}

export function down(knex) {
  return knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.dropColumn("expires_at");
  });
}
