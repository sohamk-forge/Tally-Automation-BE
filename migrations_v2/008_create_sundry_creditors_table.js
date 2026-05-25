export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("sundry_creditors", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.string("ledger_name");

      table.string("parent_group");

      table.text("address");

      table.string("alias");

      table.string("state");

      table.string("country");

      table.string("pincode");

      table.string("pan_number");

      table.string("gst_number");

      table.string("gst_registration_type");

      table.string("contact_name");

      table.string("phone_number");

      table.string("primary_phone_number");

      table.string("fax_no");

      table.string("email");

      table.decimal("opening_balance", 18, 2)
        .defaultTo(0);

      table.decimal("closing_balance", 18, 2)
        .defaultTo(0);

      table.string("opening_balance_type");

      table.string("closing_balance_type");

      table.timestamps(true, true);

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("sundry_creditors");

}