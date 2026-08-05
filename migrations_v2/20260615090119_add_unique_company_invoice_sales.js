import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("sales_invoice_extractions", (table) => {
      table.unique(["company_id", "invoice_no"], "uq_company_invoice");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("sales_invoice_extractions", (table) => {
      table.dropUnique(["company_id", "invoice_no"], "uq_company_invoice");
    });
}