// The Purchase Report's invoice-side columns — "Vendor Invoice Qty." and
// "VECV Invoice Net Val" — are what the vendor actually billed on a line.
// They replace quantity / gr_quantity and taxable_amount / gr_amount as
// the source of the pushed qty and value (see
// src/services/purchaseExcelBilling.js): the PO-side columns carried the
// full PO quantity on partial deliveries and 0.00 taxable on ZTEP rows.
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.decimal("vendor_invoice_qty", 14, 3);
    table.decimal("vendor_invoice_net_val", 14, 2);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.dropColumn("vendor_invoice_qty");
    table.dropColumn("vendor_invoice_net_val");
  });
}
