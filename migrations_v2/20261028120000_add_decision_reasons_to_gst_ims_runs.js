// An IMS decision that differs from the system's proposal now needs a reason
// (e.g. accepting an invoice that isn't in the books). Reasons are kept per
// invoice key next to the decisions they explain.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_ims_runs
      ADD COLUMN IF NOT EXISTS decision_reasons jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.gst_ims_runs DROP COLUMN IF EXISTS decision_reasons;`);
}
