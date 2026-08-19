export async function up(knex) {
  await knex.raw(`
    ALTER TABLE app_test.gst_credentials
    ADD COLUMN IF NOT EXISTS whitebooks_email TEXT;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE app_test.gst_credentials
    DROP COLUMN IF EXISTS whitebooks_email;
  `);
}