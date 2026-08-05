import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table(
      "stock_alerts",
      (table) => {

        table.decimal(
          "current_quantity",
          18,
          2
        );

        table.decimal(
          "shortage_quantity",
          18,
          2
        );

        table.boolean(
          "is_low_stock"
        ).defaultTo(false);

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table(
      "stock_alerts",
      (table) => {

        table.dropColumn(
          "current_quantity"
        );

        table.dropColumn(
          "shortage_quantity"
        );

        table.dropColumn(
          "is_low_stock"
        );

      }
    );

}