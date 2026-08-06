export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .createTable("challan_settings", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .unsigned()
        .notNullable()
        .unique()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("prefix").notNullable();

      table.bigInteger("last_number").notNullable().defaultTo(0);

      table.integer("pad_length").notNullable().defaultTo(4);

      table.timestamps(true, true);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("challan_settings");
}