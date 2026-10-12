// GSTR-3B portal stages: what each produced lives on the run.
//   portal_check    autoliab comparison + GSTN's validateautocalculatedata verdict
//   save_status     retsave / retstatus
//   portal_summary  retsum after save (carries the liability ledger ids)
//   ledger_balance  ledgers/bal (cash + credit) when the payment was planned
//   offset_plan     ITC / cash per head, and any cash shortfall
//   file_status     EVC OTP + filing
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_gstr3b_runs
      ADD COLUMN IF NOT EXISTS portal_check JSONB,
      ADD COLUMN IF NOT EXISTS save_status JSONB,
      ADD COLUMN IF NOT EXISTS portal_summary JSONB,
      ADD COLUMN IF NOT EXISTS ledger_balance JSONB,
      ADD COLUMN IF NOT EXISTS offset_plan JSONB,
      ADD COLUMN IF NOT EXISTS file_status JSONB
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_gstr3b_runs
      DROP COLUMN IF EXISTS portal_check, DROP COLUMN IF EXISTS save_status, DROP COLUMN IF EXISTS portal_summary,
      DROP COLUMN IF EXISTS ledger_balance, DROP COLUMN IF EXISTS offset_plan, DROP COLUMN IF EXISTS file_status
  `);
}
