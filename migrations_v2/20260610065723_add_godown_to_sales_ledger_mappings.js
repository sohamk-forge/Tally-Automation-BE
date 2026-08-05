import { DB_SCHEMA } from "../src/config/db.js";


export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_sales_ledger_mappings", (table) => {
      table.string("godown_name").defaultTo("Main Location");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_sales_ledger_mappings", (table) => {
      table.dropColumn("godown_name");
    });
}