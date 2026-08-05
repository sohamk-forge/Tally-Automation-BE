import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("ledgers", (table) => {

      table.bigInteger("alter_id");

    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("ledgers", (table) => {

      table.dropColumn("alter_id");

    });
}