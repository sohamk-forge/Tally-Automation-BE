export async function up(
  knex
) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(

      "stock_group_summary",

      (table) => {

        table.decimal(
          "gst_rate",
          5,
          2
        ).notNullable().defaultTo(0);

        table.decimal(
          "rate",
          15,
          2
        ).notNullable().defaultTo(0);

      }

    );

}

export async function down(
  knex
) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(

      "stock_group_summary",

      (table) => {

        table.dropColumn(
          "gst_rate"
        );

        table.dropColumn(
          "rate"
        );

      }

    );

}