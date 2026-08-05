import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .alterTable("connector_machines", (table) => {

            table.string("connector_url");

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .alterTable("connector_machines", (table) => {

            table.dropColumn("connector_url");

        });

}