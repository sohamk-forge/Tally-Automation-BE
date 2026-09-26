export async function up(knex) {

  await knex.schema

    .withSchema("app")

    .alterTable(

      "vouchers",

      (table) => {

        table.dropColumn(
          "ledger_entries"
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

        table.jsonb(
          "ledger_entries"
        );

      }

    );

}