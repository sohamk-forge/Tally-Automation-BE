// Status of the on-demand GSTR-2B generation for an IMS run.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.gst_ims_runs ADD COLUMN IF NOT EXISTS gen2b_status JSONB`);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.gst_ims_runs DROP COLUMN IF EXISTS gen2b_status`);
}
