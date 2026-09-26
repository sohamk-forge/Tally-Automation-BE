export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_feature_flags", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      // Opt-in, not opt-out (unlike company_role_permissions): a company with
      // no row for a given feature_key does NOT have that feature — this
      // table exists specifically for paid add-ons sold to one client at a
      // time, not for hiding standard pages from a subset of roles.
      table.string("feature_key")
        .notNullable();

      table.boolean("enabled")
        .notNullable()
        .defaultTo(true);

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["company_id", "feature_key"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_feature_flags");

}
