/**
 * Ledger page speed fix: all_ledger_details and group_balances are both
 * queried by company_id on every /ledgers load and every 120s poll, and
 * neither had an index on that column in the app_test schema (021_create_indexes.js
 * covers other tables but not these two). vouchers already has separate
 * company_id and voucher_date indexes; this adds the composite the
 * ledger-vouchers detail query actually filters by, now that
 * ledgerVouchers.routes.js no longer wraps voucher_date in DATE(...).
 */
export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("all_ledger_details", (table) => {

      table.index(["company_id"]);

    });

  await knex.schema
    .withSchema("app_test")
    .table("group_balances", (table) => {

      table.index(["company_id"]);

    });

  await knex.schema
    .withSchema("app_test")
    .table("vouchers", (table) => {

      table.index(["company_id", "voucher_date"], "vouchers_company_id_voucher_date_index");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("vouchers", (table) => {

      table.dropIndex(["company_id", "voucher_date"], "vouchers_company_id_voucher_date_index");

    });

  await knex.schema
    .withSchema("app_test")
    .table("group_balances", (table) => {

      table.dropIndex(["company_id"]);

    });

  await knex.schema
    .withSchema("app_test")
    .table("all_ledger_details", (table) => {

      table.dropIndex(["company_id"]);

    });

}
