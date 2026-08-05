import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("job_logs", (table) => {
            table.text("raw_response").nullable();
        });
}

export async function down(knex) {
    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("job_logs", (table) => {
            table.dropColumn("raw_response");
        });
}