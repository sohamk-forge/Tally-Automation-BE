import { DB_SCHEMA } from "../src/config/db.js";

export async function up(knex) {

  await knex.raw(`

    CREATE SCHEMA IF NOT EXISTS "${DB_SCHEMA}";

  `);

}

export async function down(knex) {

  await knex.raw(`

    DROP SCHEMA IF EXISTS "${DB_SCHEMA}" CASCADE;

  `);

}