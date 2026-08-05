import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable(
      "godown_details",
      (table) => {

        table
          .bigIncrements("id")
          .primary();

        table
          .integer("company_id")
          .unsigned();

        table
          .foreign("company_id")
          .references("id")
          .inTable(`${DB_SCHEMA}.companies`)
          .onDelete("CASCADE");

        table.text("company_name");

        table.text("godown_name");

        table.timestamp("created_at")
          .defaultTo(knex.fn.now());

        table.timestamp("updated_at")
          .defaultTo(knex.fn.now());

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists(
      "godown_details"
    );

}