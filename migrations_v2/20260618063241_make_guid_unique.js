import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
    await knex.raw(`
        ALTER TABLE ${DB_SCHEMA}.connector_machines
        ADD CONSTRAINT connector_machines_guid_unique
        UNIQUE (guid);
    `);
}

export async function down(knex) {
    await knex.raw(`
        ALTER TABLE ${DB_SCHEMA}.connector_machines
        DROP CONSTRAINT connector_machines_guid_unique;
    `);
}