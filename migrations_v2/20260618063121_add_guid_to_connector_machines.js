import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("connector_machines", (table) => {
            table.string("guid").nullable();
        });
}

export async function down(knex) {
    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("connector_machines", (table) => {
            table.dropColumn("guid");
        });
}