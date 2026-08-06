export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "invoice_extractions",
      (table) => {

        table.text(
          "last_error"
        );

        table.integer(
          "error_count"
        ).defaultTo(0);

        table.timestamp(
          "processed_at",
          {
            useTz: true
          }
        );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "invoice_extractions",
      (table) => {

        table.dropColumn(
          "last_error"
        );

        table.dropColumn(
          "error_count"
        );

        table.dropColumn(
          "processed_at"
        );

      }
    );

}