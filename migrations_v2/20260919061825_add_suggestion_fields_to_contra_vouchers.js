export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.text("suggested_party_ledger");
      table.double("suggestion_similarity");
      table.timestamp("suggestion_computed_at", {
        useTz: true,
      });
    });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_contra_company_file
    ON app_test.contra_vouchers (company_id, file_name);
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_contra_company_status
    ON app_test.contra_vouchers (company_id, status);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS app_test.idx_contra_company_file;
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS app_test.idx_contra_company_status;
  `);

  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("suggested_party_ledger");
      table.dropColumn("suggestion_similarity");
      table.dropColumn("suggestion_computed_at");
    });
}