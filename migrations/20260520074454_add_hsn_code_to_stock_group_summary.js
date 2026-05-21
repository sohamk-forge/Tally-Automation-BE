export async function up(knex) {

  await knex.schema

    .withSchema("app")

    .table(

      "stock_group_summary",

      (table) => {

        table.text(
          "hsn_code"
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app")

    .table(

      "stock_group_summary",

      (table) => {

        table.dropColumn(
          "hsn_code"
        );

      }

    );

}