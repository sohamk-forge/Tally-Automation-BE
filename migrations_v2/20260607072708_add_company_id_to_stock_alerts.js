import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table(
      "stock_alerts",
      (table) => {

        table.integer("company_id")
          .unsigned()
          .references("id")
          .inTable(`${DB_SCHEMA}.companies`)
          .onDelete("CASCADE");

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
          "company_id"
        );

      }
    );

}