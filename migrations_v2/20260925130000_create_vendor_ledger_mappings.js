/**
 * Remembers which Sundry Creditors ledger a Purchase Report vendor name is
 * posted to, per company, so the next Purchase Excel upload for the same
 * vendor pushes straight through instead of stopping at "Ledger Missing".
 */

export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .createTable("vendor_ledger_mappings", (table) => {
      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      // Lower-cased, trimmed, whitespace-collapsed vendor name — the lookup key.
      table.text("vendor_key").notNullable();
      table.text("vendor_name").notNullable();
      table.text("ledger_name").notNullable();

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["company_id", "vendor_key"]);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("vendor_ledger_mappings");
}
