/**
 * The ledger Purchase Excel invoices are posted to. Kept in its own column
 * (not the shared purchase_ledger) because purchase_ledger is also rewritten
 * by the Purchase Invoices settings and by picking a ledger on a single
 * invoice, which would silently change where Purchase Excel posts.
 */

export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_ledger_mappings", (table) => {
      table.string("purchase_excel_ledger", 255).nullable();
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("company_ledger_mappings", (table) => {
      table.dropColumn("purchase_excel_ledger");
    });
}
