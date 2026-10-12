// GSTR-1 stages 3–9 (validate on the portal, proceed to file, EVC filing):
// what each stage produced lives on the run; the authorised signatory's PAN
// (needed for EVC OTP and filing) is remembered per GSTIN.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_gstr1_runs
      ADD COLUMN IF NOT EXISTS validation JSONB,
      ADD COLUMN IF NOT EXISTS proceed_status JSONB,
      ADD COLUMN IF NOT EXISTS file_status JSONB
  `);
  await knex.raw(`ALTER TABLE ${schema}.gst_credentials ADD COLUMN IF NOT EXISTS signatory_pan VARCHAR(10)`);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.gst_credentials DROP COLUMN IF EXISTS signatory_pan`);
  await knex.raw(`
    ALTER TABLE ${schema}.gst_gstr1_runs
      DROP COLUMN IF EXISTS validation,
      DROP COLUMN IF EXISTS proceed_status,
      DROP COLUMN IF EXISTS file_status
  `);
}
