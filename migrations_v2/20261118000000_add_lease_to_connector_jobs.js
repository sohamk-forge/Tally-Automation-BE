// Lease for claimed connector jobs. A claimed job's lease is pushed forward by the
// connector's heartbeat, so a long Tally import is never treated as dead while the
// connector is alive. Only a job whose lease lapsed (connector gone) becomes 'unknown'.
export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_jobs", (table) => {
      table.timestamp("lease_expires_at", { useTz: true }).nullable();
      table.integer("max_attempts").notNullable().defaultTo(3);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_jobs", (table) => {
      table.dropColumn("lease_expires_at");
      table.dropColumn("max_attempts");
    });
}
