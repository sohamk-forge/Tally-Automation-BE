export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(
      "audit_logs",
      (table) => {

        table.string(
          "method",
          20
        );

        table.text(
          "endpoint"
        );

        table.integer(
          "status_code"
        );

        table.string(
          "log_type",
          100
        );

        table.text(
          "ip_address"
        );

        table.text(
          "user_agent"
        );

        table.bigInteger(
          "response_time_ms"
        );

        table.jsonb(
          "request_body"
        );

        table.jsonb(
          "response_body"
        );

      }
    );

}

export async function down(knex) {

}