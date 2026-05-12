export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .createTable(
      "bank_accounts",
      (table) => {

        table.increments("id");

        table.text("company_name");

        table.text("ledger_name");

        table.text("parent_group");

        table.text("account_holder_name");

        table.text("account_number");

        table.text("ifsc_code");

        table.text("swift_code");

        table.text("bank_name");

        table.text("branch");

        table.text("address");

        table.text("state");

        table.text("country");

        table.text("pincode");

        table.text("gst_number");

        table.timestamp(
          "created_at"
        ).defaultTo(
          knex.fn.now()
        );

        table.timestamp(
          "updated_at"
        ).defaultTo(
          knex.fn.now()
        );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "bank_accounts"
    );

}