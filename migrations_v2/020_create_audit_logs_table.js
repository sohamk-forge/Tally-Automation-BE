export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("audit_logs", (table) => {

      table.increments("id").primary();

      table.integer("user_id")
        .unsigned()
        .references("id")
        .inTable("app_test.users")
        .onDelete("SET NULL");

      table.string("action");

      table.string("entity");

      table.bigInteger("entity_id");

      table.jsonb("metadata");

      table.timestamp("created_at")
        .defaultTo(knex.fn.now());

      table.string("method");

      table.string("endpoint");

      table.integer("status_code");

      table.string("log_type");

      table.string("ip_address");

      table.text("user_agent");

      table.integer("response_time_ms");

      table.jsonb("request_body");

      table.jsonb("response_body");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("audit_logs");

}