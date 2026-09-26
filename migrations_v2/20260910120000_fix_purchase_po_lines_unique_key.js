// The original (company_id, po_no, po_line_item) unique key assumed a PO
// line item number is unique within a PO — SAP's own July export proves
// that's false: the same line item number gets reused across genuinely
// separate deliveries (different ODN, different invoice, same amount).
// Under the old key, the second row's upsert silently overwrote the
// first's invoice/amount/material data — a real invoice never reached
// Tally, with no error anywhere. odn is the field that's actually
// distinct between those rows, so it joins the uniqueness key. Safe to
// require non-null here: processPurchaseReportJob now skips any row with
// no odn before it ever reaches upsertPoLine, so every row this
// constraint sees is guaranteed to have one.
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.dropUnique(["company_id", "po_no", "po_line_item"]);
    table.unique(["company_id", "po_no", "po_line_item", "odn"]);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("purchase_po_lines", (table) => {
    table.dropUnique(["company_id", "po_no", "po_line_item", "odn"]);
    table.unique(["company_id", "po_no", "po_line_item"]);
  });
}
