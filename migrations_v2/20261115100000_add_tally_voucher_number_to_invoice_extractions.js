// Purchase invoices are pushed without a VOUCHERNUMBER, so Tally auto-numbers them.
// The post-invoice refresh job reads the voucher back by master ID and stores the
// number Tally assigned here (sales_invoice_extractions already has this column).
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.invoice_extractions
      ADD COLUMN IF NOT EXISTS tally_voucher_number TEXT
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.invoice_extractions DROP COLUMN IF EXISTS tally_voucher_number`);
}
