export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(
      "bank_od_accounts",
      (table) => {

        table.string(
          "sync_status"
        );

        table.text(
          "error_message"
        );

        table.text(
          "tally_response"
        );

        table.timestamp(
          "updated_at"
        );

        table.timestamp(
          "synced_at"
        );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(
      "bank_od_accounts",
      (table) => {

        table.dropColumn(
          "sync_status"
        );

        table.dropColumn(
          "error_message"
        );

        table.dropColumn(
          "tally_response"
        );

        table.dropColumn(
          "updated_at"
        );

        table.dropColumn(
          "synced_at"
        );

      }
    );

}