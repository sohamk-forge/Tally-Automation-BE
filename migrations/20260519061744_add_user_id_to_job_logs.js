export async function up(knex) {
  const hasColumn = await knex.schema
    .withSchema("app")
    .hasColumn("job_logs", "user_id");

  if (!hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("job_logs", function (table) {
        table.integer("user_id").nullable();
      });
  }
};
export async function down(knex) {
  const hasColumn = await knex.schema
    .withSchema("app")
    .hasColumn("job_logs", "user_id");

  if (hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("job_logs", function (table) {
        table.dropColumn("user_id");
      });
  }
};