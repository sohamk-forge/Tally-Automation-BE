export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_members", (table) => {

      table.increments("id").primary();

      table.integer("user_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.users")
        .onDelete("CASCADE");

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("role")
        .notNullable();

      table.integer("invited_by_user_id")
        .unsigned()
        .references("id")
        .inTable("app_test.users")
        .onDelete("SET NULL");

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["user_id", "company_id"]);

    });

  await knex.schema
    .withSchema("app_test")
    .raw(`
      ALTER TABLE app_test.company_members
      ADD CONSTRAINT company_members_role_check
      CHECK (role IN ('admin', 'accountant', 'staff'))
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_members");

}
