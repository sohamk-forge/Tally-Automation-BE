export async function up(knex) {

  await knex.schema

    .withSchema("app")

    .alterTable(

      "vouchers",

      (table) => {

        table.decimal(
          "debit_amount",
          18,
          2
        );

        table.decimal(
          "credit_amount",
          18,
          2
        );

        table.decimal(
          "balance",
          18,
          2
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app")

    .alterTable(

      "vouchers",

      (table) => {

        table.dropColumn(
          "debit_amount"
        );

        table.dropColumn(
          "credit_amount"
        );

        table.dropColumn(
          "balance"
        );

      }

    );

}