export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .createTable("user_company_profile", (table) => {
      table.increments("id").primary();

      table
        .integer("user_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${schema}.users`)
        .onDelete("CASCADE")
        .unique();

      table.string("company_name").notNullable();

      table.string("org_type", 20).notNullable();

      table.string("category").notNullable();

      table.string("team_size", 10).notNullable();

      table.string("business_type").nullable();

      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
    });

  await knex.schema
    .withSchema(schema)
    .raw(`
      ALTER TABLE ${schema}.user_company_profile
      ADD CONSTRAINT user_company_profile_org_type_check
      CHECK (org_type IN ('firm', 'business'))
    `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("user_company_profile");
}
