import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("all_ledger_details", (table) => {

      table.increments("id").primary();

      table.integer("company_id");

      table.string("company_name");

      table.string("ledger_name");

      table.string("parent_group");

      table.text("address");

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

      table.decimal("opening_balance", 18, 2);

      table.decimal("closing_balance", 18, 2);

      table.string("opening_balance_type");

      table.string("closing_balance_type");

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("all_ledger_details");

}