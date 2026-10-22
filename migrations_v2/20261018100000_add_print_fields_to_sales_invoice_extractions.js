// "Send to Tally and print" on the manual Create Sales Invoice screen.
//   print_requested        set only by that screen; bulk uploads leave it false
//   tally_master_id        LASTVCHID from Tally's import response
//   tally_voucher_number   the number Tally auto-assigned (read back by master ID)
//   voucher_row_id         vouchers.id of the copy fetched back from Tally
//   print_status           fetching | ready | failed (NULL when not requested)
//   print_error            reason when print_status = failed
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.sales_invoice_extractions
      ADD COLUMN IF NOT EXISTS print_requested BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tally_master_id TEXT,
      ADD COLUMN IF NOT EXISTS tally_voucher_number TEXT,
      ADD COLUMN IF NOT EXISTS voucher_row_id INTEGER,
      ADD COLUMN IF NOT EXISTS print_status TEXT,
      ADD COLUMN IF NOT EXISTS print_error TEXT
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.sales_invoice_extractions
      DROP COLUMN IF EXISTS print_requested,
      DROP COLUMN IF EXISTS tally_master_id,
      DROP COLUMN IF EXISTS tally_voucher_number,
      DROP COLUMN IF EXISTS voucher_row_id,
      DROP COLUMN IF EXISTS print_status,
      DROP COLUMN IF EXISTS print_error
  `);
}
