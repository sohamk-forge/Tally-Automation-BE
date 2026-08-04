export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("job_logs", (table) => {

      table.integer("company_id")
        .unsigned();

      table.foreign("company_id")
        .references("id")
        .inTable("app_test.companies")
        .onDelete("SET NULL");

      table.string("source_type");

      table.integer("source_id");

      table.text("xml");

      table.string("company");

    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("job_logs", (table) => {

      table.index(
        ["company_id", "status", "created_at"],
        "idx_job_logs_poll"
      );

    });

  await knex.raw(`
    CREATE UNIQUE INDEX idx_job_logs_dedupe
    ON app_test.job_logs (source_type, source_id)
    WHERE status IN ('pending', 'in_progress')
  `);

}

export async function down(knex) {

  await knex.raw(`
    DROP INDEX IF EXISTS app_test.idx_job_logs_dedupe
  `);

  await knex.schema
    .withSchema("app_test")
    .alterTable("job_logs", (table) => {

      table.dropIndex(
        ["company_id", "status", "created_at"],
        "idx_job_logs_poll"
      );

    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("job_logs", (table) => {

      table.dropForeign("company_id");
      table.dropColumn("company_id");
      table.dropColumn("source_type");
      table.dropColumn("source_id");
      table.dropColumn("xml");
      table.dropColumn("company");

    });

}
