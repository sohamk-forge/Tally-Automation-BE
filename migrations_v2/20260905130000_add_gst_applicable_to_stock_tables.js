export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.boolean("gst_applicable").notNullable().defaultTo(true);
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_gst_details", (table) => {
      table.boolean("gst_applicable").notNullable().defaultTo(true);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.dropColumn("gst_applicable");
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_gst_details", (table) => {
      table.dropColumn("gst_applicable");
    });
}
