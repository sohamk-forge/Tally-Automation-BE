export async function up(knex) {

  const tables = [

    "vouchers",

    "ledgers",

    "profit_loss",

    "parent_groups",

    "group_balances",

    "all_parent_groups",

    "sundry_creditors",

    "sundry_debtors",

    "bank_accounts"

  ];

  for (const tableName of tables) {

    const exists =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          tableName,
          "company_id"
        );

    if (!exists) {

      await knex.schema

        .withSchema("app")

        .alterTable(

          tableName,

          (table) => {

            table.integer(
              "company_id"
            )

            .unsigned()

            .references("id")

            .inTable(
              "app.companies"
            )

            .onDelete(
              "CASCADE"
            );

          }

        );

    }

  }

}

export async function down(knex) {

  const tables = [

    "vouchers",

    "ledgers",

    "profit_loss",

    "parent_groups",

    "group_balances",

    "all_parent_groups",

    "sundry_creditors",

    "sundry_debtors",

    "bank_accounts"

  ];

  for (const tableName of tables) {

    const exists =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          tableName,
          "company_id"
        );

    if (exists) {

      await knex.schema

        .withSchema("app")

        .alterTable(

          tableName,

          (table) => {

            table.dropColumn(
              "company_id"
            );

          }

        );

    }

  }

}