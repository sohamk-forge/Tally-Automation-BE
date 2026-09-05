/**
 * Exact mirror of invoice_app.invoices as it exists in the OCR service's
 * own database (Tally-OCR/Tally-Automation-OCR/backend-node), which is
 * where the Purchase Invoices list actually reads/writes today — see
 * backend-node/db/invoiceRepo.js. This does NOT change where that
 * service points; it's a same-shape copy of the schema in this repo's
 * own DB, in a new schema (not app_test) to keep it clearly separate
 * from this backend's own tables.
 *
 * Column shapes/defaults taken directly from invoiceRepo.js's
 * upsertInvoice/mapExtractedToRow/markInvoicePushed, plus the live
 * table structure. The (user_id, invoice_number, invoice_date) unique
 * index is what invoiceRepo.js's ON CONFLICT upsert relies on.
 */
export async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS invoice_app');

  await knex.schema
    .withSchema("invoice_app")
    .createTable("invoices", (table) => {

      table.uuid("id")
        .primary()
        .defaultTo(knex.raw("gen_random_uuid()"));

      table.string("user_id", 100)
        .notNullable();

      table.string("invoice_number", 100);

      table.date("invoice_date");

      table.string("customer_name", 255);

      table.string("supplier_name", 255);

      table.string("gstin", 15);

      table.decimal("taxable_value", 12, 2)
        .defaultTo(0);

      table.decimal("cgst", 12, 2)
        .defaultTo(0);

      table.decimal("sgst", 12, 2)
        .defaultTo(0);

      table.decimal("igst", 12, 2)
        .defaultTo(0);

      table.decimal("total_amount", 12, 2)
        .notNullable()
        .defaultTo(0);

      table.string("currency", 3)
        .defaultTo("INR");

      table.string("status", 30)
        .defaultTo("completed");

      table.string("source", 50)
        .defaultTo("ocr-pipeline");

      table.string("file_name", 255);

      table.jsonb("metadata");

      table.boolean("pushed_to_tally")
        .defaultTo(false);

      table.timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.unique(
        ["user_id", "invoice_number", "invoice_date"],
        { indexName: "invoices_user_invoice_date_unique" }
      );

    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("invoice_app")
    .dropTableIfExists("invoices");

  await knex.raw('DROP SCHEMA IF EXISTS invoice_app CASCADE');
}
