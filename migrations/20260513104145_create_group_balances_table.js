export async function up(knex) {

  await knex.schema

    .withSchema("app")

    .createTable(

      "group_balances",

      (table) => {

        table.increments("id")

          .primary();

        table.string(
          "company_name"
        );

        table.string(
          "group_name"
        );

        table.string(
          "parent_group"
        );

        table.decimal(
          "opening_balance",
          18,
          2
        );

        table.decimal(
          "closing_balance",
          18,
          2
        );

        table.timestamps(
          true,
          true
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app")

    .dropTableIfExists(
      "group_balances"
    );

}