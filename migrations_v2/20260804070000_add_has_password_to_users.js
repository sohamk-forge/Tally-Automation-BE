import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("users", (table) => {

      table.boolean("has_password").notNullable().defaultTo(true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("users", (table) => {

      table.dropColumn("has_password");

    });

}
