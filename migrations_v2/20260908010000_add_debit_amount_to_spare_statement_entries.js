export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("spare_statement_entries", (table) => {

      // The statement's own "Debit Amount" column — always a whole rupee
      // in this client's real exports, used as a reconciliation key for
      // pending_dispatch PO lines whose ODN/Ref. Doc No. never resolved
      // (see bulkPurchase.worker.js's matchPendingByAmount).
      table.decimal("debit_amount", 14, 2);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("spare_statement_entries", (table) => {
      table.dropColumn("debit_amount");
    });

}
