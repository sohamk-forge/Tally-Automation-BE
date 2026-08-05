import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists(
      "sundry_creditors"
    );

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists(
      "sundry_debtors"
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable(
      "sundry_creditors",
      (table) => {

        table.increments("id");

      }
    );

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable(
      "sundry_debtors",
      (table) => {

        table.increments("id");

      }
    );

}