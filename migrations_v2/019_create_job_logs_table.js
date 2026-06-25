export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("job_logs", (table) => {

      table.increments("id").primary();

      table.string("job_type");

      table.string("status");

      table.jsonb("payload");

      table.text("error_message");

      table.timestamp("created_at")
        .defaultTo(knex.fn.now());

      table.integer("user_id")
        .unsigned()
        .references("id")
        .inTable("app_test.users")
        .onDelete("SET NULL");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("job_logs");

}