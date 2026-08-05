import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("company_sales_ledger_mappings", (table) => {

      table.string("sales_ledger");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("company_sales_ledger_mappings", (table) => {

      table.dropColumn("sales_ledger");

    });

}