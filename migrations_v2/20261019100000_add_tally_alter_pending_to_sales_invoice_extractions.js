// Re-pushing an already-pushed sales invoice updates (Alters) the existing Tally
// voucher instead of creating a new one.
//   tally_alter_pending    TRUE while an edited invoice is waiting to be altered in
//                          Tally; the voucher is addressed by tally_master_id
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.sales_invoice_extractions
      ADD COLUMN IF NOT EXISTS tally_alter_pending BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.sales_invoice_extractions
      DROP COLUMN IF EXISTS tally_alter_pending
  `);
}
