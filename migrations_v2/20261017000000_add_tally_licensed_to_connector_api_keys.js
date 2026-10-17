/**
 * Whether the TallyPrime on the connector's machine has an active licence (as opposed to Educational
 * mode). Asked of Tally ($$LicenseInfo:IsLicensedMode) when a manual sync starts and when a connector is
 * paired, and kept until the next check. NULL = unknown (never checked, Tally closed, or no usable
 * answer) - never "unlicensed".
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.boolean("tally_licensed").nullable();
    table.timestamp("tally_licence_checked_at", { useTz: true }).nullable();
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("connector_api_keys", (table) => {
    table.dropColumn("tally_licence_checked_at");
    table.dropColumn("tally_licensed");
  });
}
