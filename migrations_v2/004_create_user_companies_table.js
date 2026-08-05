import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("user_companies", (table) => {

      table.increments("id").primary();

      table.integer("user_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.users`)
        .onDelete("CASCADE");

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("user_companies");

}