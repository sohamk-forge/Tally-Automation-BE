export async function up(knex) {

  await knex.schema.withSchema("app")

    .createTable(
      "all_parent_groups",

      (table) => {

        table.bigIncrements("id")
          .primary();

        table.text(
          "company_name"
        );

        table.text(
          "ledger_name"
        );

        table.text(
          "parent_group"
        );

        table.text(
          "address"
        );

        table.text(
          "state"
        );

        table.text(
          "country"
        );

        table.text(
          "pincode"
        );

        table.text(
          "pan_number"
        );

        table.text(
          "gst_number"
        );

        table.text(
          "gst_registration_type"
        );

        table.text(
          "contact_name"
        );

        table.text(
          "phone_number"
        );

        table.text(
          "primary_phone_number"
        );

        table.text(
          "fax_no"
        );

        table.text(
          "email"
        );

        table.decimal(
          "opening_balance",
          18,
          2
        );

        table.decimal(
          "closing_balance",
          18,
          2
        );

        table.text(
          "opening_balance_type"
        );

        table.text(
          "closing_balance_type"
        );

        table.timestamps(
          true,
          true
        );

      }

    );

}

export async function down(knex) {

  await knex.schema.withSchema("app")

    .dropTableIfExists(
      "all_parent_groups"
    );

}