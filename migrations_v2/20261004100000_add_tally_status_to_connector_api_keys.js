/**
 * The connector device checks whether Tally answers on its own machine
 * (default localhost:9000) and reports the result with its job polling.
 * Stored next to last_seen_at on its API key so "connector online" and
 * "Tally up" are read from the same row. tally_connected is NULL until a
 * connector that reports this has polled at least once.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.boolean("tally_connected").nullable();
    table.timestamp("tally_checked_at", { useTz: true }).nullable();
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.dropColumn("tally_checked_at");
    table.dropColumn("tally_connected");
  });
}
