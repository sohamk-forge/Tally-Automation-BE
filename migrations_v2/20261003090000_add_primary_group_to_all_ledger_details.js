/**
 * all_ledger_details.parent_group only holds a ledger's IMMEDIATE Tally group.
 * A ledger sitting under a user-created sub-group (e.g. "ABC" under Sundry
 * Creditors) was therefore never recognised as a creditor on the Ledger page.
 *
 * primary_group is filled by the all-ledgers sync by walking the Tally group
 * hierarchy upward until it reaches Sundry Debtors / Sundry Creditors /
 * Bank Accounts / Bank OD A/c, or otherwise the top-level (Primary) group.
 * Nullable: rows synced before this column existed fall back to parent_group.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("all_ledger_details", (table) => {
    table.text("primary_group").nullable();
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("all_ledger_details", (table) => {
    table.dropColumn("primary_group");
  });
}
