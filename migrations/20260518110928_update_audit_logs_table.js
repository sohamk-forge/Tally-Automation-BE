export async function up(knex) {

  const columns = [

    {
      name: "method",
      type: "string"
    },

    {
      name: "endpoint",
      type: "text"
    },

    {
      name: "status_code",
      type: "integer"
    },

    {
      name: "log_type",
      type: "string"
    },

    {
      name: "ip_address",
      type: "text"
    },

    {
      name: "user_agent",
      type: "text"
    },

    {
      name: "response_time_ms",
      type: "bigInteger"
    },

    {
      name: "request_body",
      type: "jsonb"
    },

    {
      name: "response_body",
      type: "jsonb"
    }

  ];

  for (const column of columns) {

    const exists =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          "audit_logs",
          column.name
        );

    if (!exists) {

      await knex.schema
        .withSchema("app")
        .alterTable(

          "audit_logs",

          (table) => {

            if (
              column.type === "string"
            ) {

              table.string(
                column.name,
                255
              );

            }

            else if (
              column.type === "text"
            ) {

              table.text(
                column.name
              );

            }

            else if (
              column.type === "integer"
            ) {

              table.integer(
                column.name
              );

            }

            else if (
              column.type === "bigInteger"
            ) {

              table.bigInteger(
                column.name
              );

            }

            else if (
              column.type === "jsonb"
            ) {

              table.jsonb(
                column.name
              );

            }

          }

        );

    }

  }

}

export async function down(knex) {

}