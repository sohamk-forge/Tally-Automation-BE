// The originally-captured `quantity` is the full PO-ordered amount, which
// is wrong to push as a voucher line's qty when a PO gets fulfilled across
// multiple partial deliveries (one ODN each) — every partial delivery was
// carrying the FULL PO quantity, not what was actually received/billed on
// that specific delivery. `gr_quantity` (GR Qty. from the Purchase Report)
// is the real per-delivery quantity; `quantity` is kept as-is since it's
// still useful as "what the PO originally asked for" for reconciliation.
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.decimal("gr_quantity", 14, 3);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.dropColumn("gr_quantity");
  });
}
