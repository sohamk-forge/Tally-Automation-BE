export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table(
      "sales_invoice_extractions",
      (table) => {

        table.jsonb(
          "stock_details"
        );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .table(
      "sales_invoice_extractions",
      (table) => {

        table.dropColumn(
          "stock_details"
        );

      }
    );

}