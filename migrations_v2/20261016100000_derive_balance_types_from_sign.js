/**
 * Re-derives opening/closing Dr/Cr from the stored signed balance
 * (Tally convention: negative = Dr, positive = Cr), matching the sync's
 * balanceTypeOf(). Fixes rows written by the old sync code:
 *   - all_parent_groups had the mapping reversed (negative → "Cr");
 *   - zero balances were labelled "Cr" (or "Dr") instead of having no side.
 * Data-only; down() is a no-op because the old labels were wrong.
 */

const TABLES = ["all_ledger_details", "bank_accounts", "all_parent_groups"];

const sideOf = (col) => `
  CASE
    WHEN ${col} IS NULL OR abs(${col}) < 0.005 THEN NULL
    WHEN ${col} < 0 THEN 'Dr'
    ELSE 'Cr'
  END`;

export async function up(knex) {
  for (const table of TABLES) {
    const exists = await knex.schema.withSchema("app_test").hasTable(table);
    if (!exists) continue;
    await knex.raw(`
      UPDATE app_test.${table}
         SET opening_balance_type = ${sideOf("opening_balance")},
             closing_balance_type = ${sideOf("closing_balance")}
       WHERE opening_balance_type IS DISTINCT FROM ${sideOf("opening_balance")}
          OR closing_balance_type IS DISTINCT FROM ${sideOf("closing_balance")}
    `);
  }
}

export async function down() {}
