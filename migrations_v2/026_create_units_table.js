import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("units", (table) => {

      table.increments("id").primary();

      table.string("guid").unique();

      table.string("master_id");

      table.integer("alter_id")
        .defaultTo(0);

      table.integer("company_id")
        .notNullable();

      table.string("company_name")
        .notNullable();

      table.string("unit_name")
        .notNullable();

      table.timestamp("created_at")
        .defaultTo(knex.fn.now());

      table.timestamp("updated_at")
        .defaultTo(knex.fn.now());

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("units");

}