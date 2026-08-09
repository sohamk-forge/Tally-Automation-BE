export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_role_permissions", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("role")
        .notNullable();

      table.string("page_key")
        .notNullable();

      table.boolean("enabled")
        .notNullable()
        .defaultTo(true);

      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["company_id", "role", "page_key"]);

    });

  await knex.schema
    .withSchema("app_test")
    .raw(`
      ALTER TABLE app_test.company_role_permissions
      ADD CONSTRAINT company_role_permissions_role_check
      CHECK (role IN ('accountant', 'staff'))
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_role_permissions");

}
