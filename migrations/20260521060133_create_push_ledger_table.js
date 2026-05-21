export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .createTable(

      "push_ledger",

      (table) => {

        table.bigIncrements("id");

        table.bigInteger("ledger_id");

        table.text("company_name");

        table.text("ledger_name");

        table.text("parent_name");

        table.decimal("opening_balance");

        table.text("bill_wise");

        table.text("address");

        table.text("pincode");

        table.text("state");

        table.text("country");

        table.text("contact_person");

        table.text("phone");

        table.text("mobile");

        table.text("email");

        table.text("website");

        table.text("pan");

        table.text("gstin");

        table.text("gst_registration_type");

        table.text("status")
          .defaultTo("pending");

        table.text("tally_response");

        table.text("error_message");

        table.timestamp("sync_at");

        table.timestamp("created_at")
          .defaultTo(
            knex.fn.now()
          );

        table.timestamp("updated_at")
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
      "push_ledger"
    );

}