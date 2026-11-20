/**
 * Which company is open (active) in the TallyPrime window on the connector's machine, as the connector
 * last reported it with its heartbeat (same freshness window as tally_connected). NULL = unknown (not
 * reported, Tally closed, or a connector build that does not send it) - never "wrong company".
 */

export async function up(knex) {
  // Safe to re-run: a database that already got the column by hand is left alone.
  if (await knex.schema.withSchema("app_test").hasColumn("connector_api_keys", "tally_company")) return;
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.text("tally_company").nullable();
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.dropColumn("tally_company");
  });
}
