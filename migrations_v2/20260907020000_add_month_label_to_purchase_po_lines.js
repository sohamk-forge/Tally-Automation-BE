export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("purchase_po_lines", (table) => {

      // The month the user picked in the upload modal, NOT derived from
      // po_date — a SAP export's own PO-date range can spill a few days
      // either side of a calendar month, and the label needs to match
      // what the user actually uploaded that batch as, for the Months
      // table / drill-down / per-month Excel report to group correctly.
      table.text("month_label");

    });

  await knex.schema
    .withSchema("app_test")
    .raw(`
      CREATE INDEX purchase_po_lines_company_month_idx
      ON app_test.purchase_po_lines (company_id, month_label)
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("purchase_po_lines", (table) => {
      table.dropColumn("month_label");
    });

}
