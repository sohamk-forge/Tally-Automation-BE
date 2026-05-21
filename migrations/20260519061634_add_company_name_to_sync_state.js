export async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("app")
    .hasColumn("sync_state", "company_name");

  if (!hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("sync_state", function (table) {
        table.text("company_name").nullable();
      });
  }
};
export async function down(knex) {
    const hasColumn = await knex.schema
    .withSchema("app")
    .hasColumn("sync_state", "company_name");

  if (hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("sync_state", function (table) {
        table.dropColumn("company_name");
      });
  }
};