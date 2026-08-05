import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("company_sales_ledger_mappings", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.string("sales_parent_group");

      table.string("cgst_ledger");

      table.string("sgst_ledger");

      table.string("igst_ledger");

      table.string("tds_ledger");

      table.string("cess_ledger");

      table.string("rounded_off_ledger");

      table.timestamps(true, true);

      table.unique(["company_id"]);
    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("company_sales_ledger_mappings");

}
