import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
    await knex.raw(`
        ALTER TABLE ${DB_SCHEMA}.connector_machines
        ALTER COLUMN guid SET NOT NULL;
    `);
}

export async function down(knex) {
    await knex.raw(`
        ALTER TABLE ${DB_SCHEMA}.connector_machines
        ALTER COLUMN guid DROP NOT NULL;
    `);
}