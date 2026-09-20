/**
 * uq_app_test_vouchers_guid was unique on guid alone, but a Tally voucher's
 * GUID is identical for every company_id paired to the same Tally company
 * file, so a second pairing could only insert vouchers nobody else owned.
 * The (company_id, voucher_number, voucher_date) constraint also collapsed
 * distinct vouchers, since Tally numbers restart per voucher type.
 * Identity becomes (company_id, guid).
 */

export async function up(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.uq_app_test_vouchers_guid`);

  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.dropUnique(
      ["company_id", "voucher_number", "voucher_date"],
      "uq_app_test_vouchers_company_number_date"
    );
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_app_test_vouchers_company_guid
    ON app_test.vouchers (company_id, guid)
    WHERE guid IS NOT NULL AND guid <> ''
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.uq_app_test_vouchers_company_guid`);

  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.unique(
      ["company_id", "voucher_number", "voucher_date"],
      "uq_app_test_vouchers_company_number_date"
    );
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_app_test_vouchers_guid
    ON app_test.vouchers (guid)
    WHERE guid IS NOT NULL AND guid <> ''
  `);
}
