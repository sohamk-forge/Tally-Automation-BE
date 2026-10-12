// WhiteBooks client_id / client_secret / email now come from the backend
// .env (one platform WhiteBooks account), not from the user. gst_credentials
// only needs to remember the per-company GSTIN + GST portal username.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_credentials
      ALTER COLUMN client_id DROP NOT NULL,
      ALTER COLUMN client_secret_enc DROP NOT NULL;
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.gst_credentials
      ALTER COLUMN client_id SET NOT NULL,
      ALTER COLUMN client_secret_enc SET NOT NULL;
  `);
}
