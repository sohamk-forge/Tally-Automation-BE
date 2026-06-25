export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "push_stock_item",
      (table) => {

        table
          .string("gst_applicable")
          .defaultTo("Applicable");

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "push_stock_item",
      (table) => {

        table.dropColumn(
          "gst_applicable"
        );

      }
    );

}