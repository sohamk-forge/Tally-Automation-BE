// `Total Taxable Amount`/`Tax Amount`/`Amount` on a PO line sometimes repeat
// the full PO-level total on every partial-delivery row instead of being
// split per delivery. `GR Amount` (GR Amount from the Purchase Report) is
// already correctly split per delivery in the source data — see
// pushMatchedLinesToInvoices() for how it's used to correct the pushed
// voucher line's amount.
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.decimal("gr_amount", 14, 2);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.dropColumn("gr_amount");
  });
}
