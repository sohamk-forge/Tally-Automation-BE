export async function up(knex) {

  await knex.raw(`
    
    CREATE SCHEMA IF NOT EXISTS app_test;

  `);

}

export async function down(knex) {

  await knex.raw(`
    
    DROP SCHEMA IF EXISTS app_test CASCADE;

  `);

}