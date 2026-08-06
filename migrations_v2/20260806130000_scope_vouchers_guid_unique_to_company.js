export async function up(knex) {
  await knex.raw(`DROP INDEX app_test.uq_app_test_vouchers_guid`);
  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.unique(["company_id", "guid"], "uq_app_test_vouchers_company_guid");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.dropUnique(["company_id", "guid"], "uq_app_test_vouchers_company_guid");
  });
  await knex.raw(
    `CREATE UNIQUE INDEX uq_app_test_vouchers_guid ON app_test.vouchers (guid)`
  );
}
