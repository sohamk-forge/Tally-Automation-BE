export async function up(knex) {

  await knex.schema

    .withSchema("app_test")

    .createTable(

      "push_bank",

      (table) => {

        table
          .bigIncrements("id")
          .primary();

        table.string(
          "company_name"
        );

        table.string(
          "ledger_name"
        );

        table.string(
          "parent_group"
        );

        table.decimal(
          "opening_balance",
          18,
          2
        );

        table.string(
          "bank_name"
        );

        table.string(
          "branch_name"
        );

        table.string(
          "account_holder"
        );

        table.string(
          "account_number"
        );

        table.string(
          "ifsc_code"
        );

        table.string(
          "swift_code"
        );

        table.text(
          "address"
        );

        table.string(
          "state"
        );

        table.string(
          "country"
        );

        table.string(
          "pincode"
        );

        table.string(
          "contact_person"
        );

        table.string(
          "mobile"
        );

        table.string(
          "email"
        );

        table.text(
          "tally_response"
        );

        table.timestamp(
          "created_at"
        )
        .defaultTo(
          knex.fn.now()
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app_test")

    .dropTableIfExists(
      "push_bank"
    );

}