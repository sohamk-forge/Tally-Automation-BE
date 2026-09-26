export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("purchase_po_lines", (table) => {

      // Set only when a pending_dispatch row's amount-based match against
      // the Spare Statement was ambiguous (multiple statement candidates,
      // or the same rounded amount shared by more than one pending PO) —
      // a human-readable hint for the pending-dispatch report/UI, never
      // auto-resolved. Cleared back to NULL once a row is confidently
      // matched some other way.
      table.text("amount_match_note");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("purchase_po_lines", (table) => {
      table.dropColumn("amount_match_note");
    });

}
