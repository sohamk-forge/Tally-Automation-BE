/**
 * ODLIMIT was already being fetched from Tally's GroupSummaryBank export
 * (xmlBuilder.js) but silently dropped before the insert — bank_accounts
 * had no column to store it. Confirmed via a direct Tally XML test that
 * ODLIMIT returns real values for OD/CC ledgers (e.g. ICICI BANK CA:
 * 5,000,000.00), needed for OD utilization / interest cost analysis.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("bank_accounts", (table) => {
    table.decimal("od_limit", 18, 2);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("bank_accounts", (table) => {
    table.dropColumn("od_limit");
  });
}
