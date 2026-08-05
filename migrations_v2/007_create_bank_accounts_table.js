import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("bank_accounts", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.string("ledger_name");

      table.string("parent_group");

      table.string("account_holder_name");

      table.string("account_number");

      table.string("ifsc_code");

      table.string("swift_code");

      table.string("bank_name");

      table.string("branch");

      table.text("address");

      table.string("state");

      table.string("country");

      table.string("pincode");

      table.string("gst_number");

      table.timestamps(true, true);

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

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
    .dropTableIfExists("bank_accounts");

}