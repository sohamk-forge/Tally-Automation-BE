import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.timestamp("jwt_expires_at");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.dropColumn("jwt_expires_at");

    });

}