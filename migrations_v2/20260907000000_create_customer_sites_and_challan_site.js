export async function up(knex) {
  const schema = "app_test";

  // 1. Create customer_sites table
  const hasCustomerSites = await knex.schema
    .withSchema(schema)
    .hasTable("customer_sites");

  if (!hasCustomerSites) {
    await knex.schema
      .withSchema(schema)
      .createTable("customer_sites", (table) => {
        table.increments("id").primary();

        table
          .integer("company_id")
          .notNullable()
          .references("id")
          .inTable(`${schema}.companies`);

        // No customers table exists in this app — a customer is just the
        // Tally ledger name string, same as challans.customer_name.
        table.string("customer_name", 255).notNullable();
        table.string("site_name", 255).notNullable();

        table
          .timestamp("created_at")
          .notNullable()
          .defaultTo(knex.fn.now());
      });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS "idx_customer_sites_company_customer"
    ON "${schema}"."customer_sites" ("company_id", "customer_name")
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_sites_company_customer_name"
    ON "${schema}"."customer_sites" ("company_id", "customer_name", "site_name")
  `);

  // 2. Add site_id (FK) if it doesn't exist
  const hasSiteId = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "site_id");

  if (!hasSiteId) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        table
          .integer("site_id")
          .references("id")
          .inTable(`${schema}.customer_sites`);
      });
  }

  // 3. Add site_name (denormalized snapshot) if it doesn't exist
  const hasSiteName = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "site_name");

  if (!hasSiteName) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        table.string("site_name", 255);
      });
  }
}

export async function down(knex) {
  const schema = "app_test";

  const hasSiteId = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "site_id");

  const hasSiteName = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "site_name");

  if (hasSiteId || hasSiteName) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        if (hasSiteId) table.dropColumn("site_id");
        if (hasSiteName) table.dropColumn("site_name");
      });
  }

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("customer_sites");
}
