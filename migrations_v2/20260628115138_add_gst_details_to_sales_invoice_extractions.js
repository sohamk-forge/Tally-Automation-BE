export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table(
      "sales_invoice_extractions",
      (table) => {

        table.jsonb(
          "gst_details"
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
          "gst_details"
        );

      }
    );

}