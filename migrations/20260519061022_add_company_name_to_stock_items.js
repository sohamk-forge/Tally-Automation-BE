export async function up(knex) {
  const exists = await knex.schema
    .withSchema("app")
    .hasColumn("stock_items", "company_name");

  if (!exists) {
    await knex.schema
      .withSchema("app")
      .alterTable("stock_items", function (table) {
        table.text("company_name").nullable();
      });
  }
};

export async function down(knex) {
  const exists = await knex.schema
    .withSchema("app")
    .hasColumn("stock_items", "company_name");

  if (exists) {
    await knex.schema
      .withSchema("app")
      .alterTable("stock_items", function (table) {
        table.dropColumn("company_name");
      });
  }
};