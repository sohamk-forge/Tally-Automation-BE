import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table(
      "sales_invoice_extractions",
      (table) => {

        table.jsonb(
          "stock_details"
        );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table(
      "sales_invoice_extractions",
      (table) => {

        table.dropColumn(
          "stock_details"
        );

      }
    );

}