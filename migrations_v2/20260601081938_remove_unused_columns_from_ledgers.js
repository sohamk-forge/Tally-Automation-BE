export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("ledgers", (table) => {

      table.dropColumn("tally_ledger_id");
      table.dropColumn("group_name");
      table.dropColumn("alter_id");
      table.dropColumn("parent_group");
      table.dropColumn("address");
      table.dropColumn("state");
      table.dropColumn("gst_type");
      table.dropColumn("pan_number");
      table.dropColumn("opening_balance");
      table.dropColumn("opening_balance_type");
      table.dropColumn("email");
      table.dropColumn("phone");
      table.dropColumn("country");
      table.dropColumn("pincode");
      table.dropColumn("mobile");
      table.dropColumn("contact_person");
      table.dropColumn("closing_balance");
      table.dropColumn("credit_period");
      table.dropColumn("bill_wise");
      table.dropColumn("revenue_ledger");
      table.dropColumn("deemed_positive");
      table.dropColumn("master_id");

    });

}

export async function down(knex) {

  // optional rollback

}