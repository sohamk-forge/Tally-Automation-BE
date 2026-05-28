export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .createTable(
      "bank_od_accounts",
      (table) => {

        table.bigIncrements("id")
          .primary();

        table.text("company_name");

        table.text("ledger_name");

        table.text("account_type");
        // OD / OCC

        table.decimal(
          "opening_balance",
          18,
          2
        );

        table.decimal(
          "od_limit",
          18,
          2
        );

        table.text("bank_name");

        table.text("branch_name");

        table.text("account_holder");

        table.text("account_number");

        table.text("ifsc_code");

        table.text("swift_code");

        table.text("address");

        table.text("state");

        table.text("country");

        table.text("pincode");

        table.text("contact_person");

        table.text("mobile");

        table.text("email");

        table.timestamp("created_at")
          .defaultTo(
            knex.fn.now()
          );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "bank_od_accounts"
    );

}