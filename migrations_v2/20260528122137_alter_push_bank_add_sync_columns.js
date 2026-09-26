export async function up(knex) {

  await knex.schema

    .withSchema("app_test")

    .alterTable(

      "push_bank",

      (table) => {

        table.string(
          "sync_status"
        );

        table.text(
          "error_message"
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

    .withSchema("app_test")

    .alterTable(

      "push_bank",

      (table) => {

        table.dropColumn(
          "sync_status"
        );

        table.dropColumn(
          "error_message"
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