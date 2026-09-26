export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("spare_statement_entries", (table) => {

      // The month the user picked when uploading this statement — same
      // rationale as purchase_po_lines.month_label: not derived from
      // posting_date, needs to match what the user actually called this
      // upload, so the monthly reconciliation report groups correctly.
      table.text("month_label");

    });

  await knex.schema
    .withSchema("app_test")
    .raw(`
      CREATE INDEX spare_statement_entries_company_month_idx
      ON app_test.spare_statement_entries (company_id, month_label)
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("spare_statement_entries", (table) => {
      table.dropColumn("month_label");
    });

}
