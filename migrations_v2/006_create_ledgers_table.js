export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("ledgers", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.bigInteger("tally_ledger_id");

      table.string("name");

      table.string("group_name");

      table.bigInteger("alter_id");

      table.timestamps(true, true);

      table.string("parent_group");

      table.text("address");

      table.string("state");

      table.string("gst_number");

      table.string("gst_type");

      table.string("pan_number");

      table.decimal("opening_balance", 18, 2)
        .defaultTo(0);

      table.string("opening_balance_type");

      table.string("company_name");

      table.string("email");

      table.string("phone");

      table.string("country");

      table.string("pincode");

      table.string("mobile");

      table.string("contact_person");

      table.decimal("closing_balance", 18, 2)
        .defaultTo(0);

      table.integer("credit_period");

      table.string("bill_wise");

      table.string("revenue_ledger");

      table.string("deemed_positive");

      table.string("guid");

      table.bigInteger("master_id");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("ledgers");

}