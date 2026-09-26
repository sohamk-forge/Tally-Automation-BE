export async function up(knex) {
    await knex.raw(`
        ALTER TABLE app_test.connector_machines
        ALTER COLUMN guid SET NOT NULL;
    `);
}

export async function down(knex) {
    await knex.raw(`
        ALTER TABLE app_test.connector_machines
        ALTER COLUMN guid DROP NOT NULL;
    `);
}