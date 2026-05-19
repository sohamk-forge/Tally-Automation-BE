export async function up(knex) {

  const tables = [

    "companies",
    "ledgers",
    "sundry_creditors",
    "sundry_debtors",
    "bank_accounts",
    "vouchers",
    "parent_groups",
    "group_balances",
    "all_parent_groups",
    "profit_loss"

  ];

  for (const tableName of tables) {

    const hasGuid =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          tableName,
          "guid"
        );

    if (!hasGuid) {

      await knex.schema
        .withSchema("app")
        .alterTable(
          tableName,
          (table) => {

            table.string(
              "guid",
              255
            );

          }
        );

    }

    const hasMasterId =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          tableName,
          "master_id"
        );

    if (!hasMasterId) {

      await knex.schema
        .withSchema("app")
        .alterTable(
          tableName,
          (table) => {

            table.bigInteger(
              "master_id"
            );

          }
        );

    }

    const hasAlterId =

      await knex.schema
        .withSchema("app")
        .hasColumn(
          tableName,
          "alter_id"
        );

    if (!hasAlterId) {

      await knex.schema
        .withSchema("app")
        .alterTable(
          tableName,
          (table) => {

            table.bigInteger(
              "alter_id"
            );

          }
        );

    }

  }

}

export async function down(knex) {

}