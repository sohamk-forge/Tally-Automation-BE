/**
 * app_test.units has a GLOBAL unique constraint on guid alone
 * (026_create_units_table.js), but the guid itself is synthesized purely
 * from (company name + unit name) — never scoped by company_id — and the
 * app's own upsert logic (upsertRecord in sync.routes.js) already treats
 * guid as scoped per company: `WHERE guid = $1 AND company_id = $2`.
 *
 * Common unit names ("Nos", "Pcs", "Kg", "Box", ...) repeat across
 * unrelated companies, so the global constraint rejects perfectly valid
 * upserts for any second company the moment it syncs a unit name another
 * company already has. This migration drops the global constraint and
 * replaces it with a composite (guid, company_id) constraint, matching
 * how every other synced table in this schema behaves.
 */

export async function up(knex) {
  // Keep the most recently updated row for each (guid, company_id) pair,
  // delete the rest — a couple of rows may already collide under the old
  // global constraint's failed-insert retries.
  await knex.raw(`
    DELETE FROM app_test.units u
    USING app_test.units dupe
    WHERE u.guid = dupe.guid
      AND u.company_id = dupe.company_id
      AND (
        u.updated_at < dupe.updated_at
        OR (u.updated_at = dupe.updated_at AND u.id < dupe.id)
      )
  `);

  await knex.schema.withSchema("app_test").alterTable("units", (table) => {
    table.dropUnique(["guid"]);
    table.unique(["guid", "company_id"], "units_guid_company_unique");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("units", (table) => {
    table.dropUnique(["guid", "company_id"], "units_guid_company_unique");
    table.unique(["guid"]);
  });
}
