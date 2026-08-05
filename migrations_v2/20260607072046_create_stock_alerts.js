import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable(
      "stock_alerts",
      (table) => {

        table.bigIncrements("id")
          .primary();

        table.text("company_name");

        table.text("item_name");

        table.decimal(
          "minimum_alert_quantity",
          18,
          2
        );

        table.boolean("is_active")
          .defaultTo(true);

        table.timestamp("created_at")
          .defaultTo(
            knex.fn.now()
          );

        table.timestamp("updated_at")
          .defaultTo(
            knex.fn.now()
          );

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists(
      "stock_alerts"
    );

}