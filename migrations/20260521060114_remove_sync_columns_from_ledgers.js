export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(

      "ledgers",

      (table) => {

        table.dropColumn("status");

        table.dropColumn("tally_response");

        table.dropColumn("error_message");

        table.dropColumn("sync_at");

      }

    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(

      "ledgers",

      (table) => {

        table.text("status");

        table.text("tally_response");

        table.text("error_message");

        table.timestamp("sync_at");

      }

    );

}