import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable(
      "push_stock_item",
      (table) => {

        table
          .string("gst_applicable")
          .defaultTo("Applicable");

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable(
      "push_stock_item",
      (table) => {

        table.dropColumn(
          "gst_applicable"
        );

      }
    );

}