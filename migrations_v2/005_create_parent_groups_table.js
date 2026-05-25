export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("parent_groups", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.string("group_name");

      table.timestamps(true, true);

      table.string("primary_group");

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("parent_groups");

}