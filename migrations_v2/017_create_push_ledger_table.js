import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("push_ledger", (table) => {

      table.increments("id").primary();

      table.bigInteger("ledger_id");

      table.string("company_name");

      table.string("ledger_name");

      table.string("parent_name");

      table.decimal("opening_balance", 18, 2)
        .defaultTo(0);

      table.string("bill_wise");

      table.text("address");

      table.string("pincode");

      table.string("state");

      table.string("country");

      table.string("contact_person");

      table.string("phone");

      table.string("mobile");

      table.string("email");

      table.string("website");

      table.string("pan");

      table.string("gstin");

      table.string("gst_registration_type");

      table.string("status");

      table.text("tally_response");

      table.text("error_message");

      table.timestamp("sync_at");

      table.timestamps(true, true);

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("push_ledger");

}