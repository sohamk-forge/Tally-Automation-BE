import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_stock_item", (table) => {

      table.decimal(
        "opening_quantity",
        18,
        2
      );

      table.decimal(
        "opening_rate",
        18,
        2
      );

      table.decimal(
        "opening_value",
        18,
        2
      );

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_stock_item", (table) => {

      table.dropColumn(
        "opening_quantity"
      );

      table.dropColumn(
        "opening_rate"
      );

      table.dropColumn(
        "opening_value"
      );

    });

}