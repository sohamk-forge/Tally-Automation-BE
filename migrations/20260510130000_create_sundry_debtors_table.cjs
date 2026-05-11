exports.up = function(knex) {

  return knex.schema

    .withSchema("app")

    .createTable(
      "sundry_debtors",
      (table) => {

        table
          .increments("id")
          .primary();

        table.text("company_name");

        table.text("ledger_name");

        table.text("parent_group");

        table.text("address");

        table.text("alias");

        table.text("state");

        table.text("country");

        table.text("pincode");

        table.text("pan_number");

        table.text("gst_number");

        table.text(
          "gst_registration_type"
        );

        table.text("contact_name");

        table.text("phone_number");

        table.text(
          "primary_phone_number"
        );

        table.text("fax_no");

        table.text("email");

        table.text(
          "opening_balance"
        );

        table.text(
          "closing_balance"
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

};

exports.down = function(knex) {

  return knex.schema

    .withSchema("app")

    .dropTableIfExists(
      "sundry_debtors"
    );

};