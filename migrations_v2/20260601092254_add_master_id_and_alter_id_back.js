import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("ledgers", (table) => {

      table.bigInteger("master_id");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("ledgers", (table) => {

      table.dropColumn("master_id");

    });

}