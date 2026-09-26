export async function up(knex) {
    await knex.raw(`
        ALTER TABLE app_test.connector_machines
        ADD CONSTRAINT connector_machines_guid_unique
        UNIQUE (guid);
    `);
}

export async function down(knex) {
    await knex.raw(`
        ALTER TABLE app_test.connector_machines
        DROP CONSTRAINT connector_machines_guid_unique;
    `);
}