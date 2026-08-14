export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.string("unit");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.dropColumn("unit");
    });
}