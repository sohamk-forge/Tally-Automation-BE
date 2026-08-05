import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("users", (table) => {

      table.increments("id").primary();

      table.string("email")
        .notNullable()
        .unique();

      table.string("password")
        .notNullable();

      table.string("role")
        .defaultTo("user");

      table.string("phone");

      table.string("first_name");

      table.string("last_name");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("users");

}