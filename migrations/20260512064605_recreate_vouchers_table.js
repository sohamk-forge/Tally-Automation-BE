export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .createTable(
      "vouchers",
      (table) => {

        table.increments("id");

        table.text(
          "company_name"
        );

        table.date(
          "voucher_date"
        );

        table.text(
          "voucher_type"
        );

        table.text(
          "voucher_number"
        );

        table.text(
          "party_ledger_name"
        );

        table.text(
          "narration"
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
      "vouchers"
    );

}