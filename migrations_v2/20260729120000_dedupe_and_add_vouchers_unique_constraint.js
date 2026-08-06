/**
 * app_test.vouchers was never given the guid / (company_id, voucher_number,
 * voucher_date) unique constraints that app.vouchers received in
 * 20260519120000_add_indexes_and_constraints.js. Combined with a
 * check-then-insert race in the /voucher-sync route, this let duplicate
 * rows accumulate. This migration removes the existing duplicates (keeping
 * the most recently updated row per key) and adds the missing constraints
 * so future duplicates are rejected at the DB level.
 */

export async function up(knex) {
  // Keep the most recently updated row for each (company_id, voucher_number,
  // voucher_date), delete the rest.
  await knex.raw(`
    DELETE FROM app_test.vouchers v
    USING app_test.vouchers dupe
    WHERE v.company_id = dupe.company_id
      AND v.voucher_number = dupe.voucher_number
      AND v.voucher_date = dupe.voucher_date
      AND (
        v.updated_at < dupe.updated_at
        OR (v.updated_at = dupe.updated_at AND v.id < dupe.id)
      )
  `);

  // guid can be null/blank for older rows (fallback guid was only added
  // later), so only enforce uniqueness where it's actually set.
  await knex.raw(`
    DELETE FROM app_test.vouchers v
    USING app_test.vouchers dupe
    WHERE v.guid IS NOT NULL
      AND v.guid <> ''
      AND v.guid = dupe.guid
      AND (
        v.updated_at < dupe.updated_at
        OR (v.updated_at = dupe.updated_at AND v.id < dupe.id)
      )
  `);

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

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.uq_app_test_vouchers_guid`);

  await knex.schema.withSchema("app_test").alterTable("vouchers", (table) => {
    table.dropUnique(
      ["company_id", "voucher_number", "voucher_date"],
      "uq_app_test_vouchers_company_number_date"
    );
  });
}
