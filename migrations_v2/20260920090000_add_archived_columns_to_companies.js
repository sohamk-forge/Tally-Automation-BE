export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("companies", (table) => {
    table.timestamp("archived_at", { useTz: true }).nullable();
    table
      .integer("merged_into_company_id")
      .nullable()
      .references("id")
      .inTable("app_test.companies")
      .onDelete("SET NULL");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("companies", (table) => {
    table.dropColumn("merged_into_company_id");
    table.dropColumn("archived_at");
  });
}
