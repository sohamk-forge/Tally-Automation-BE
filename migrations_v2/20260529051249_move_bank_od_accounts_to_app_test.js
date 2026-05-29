export async function up(knex) {

  await knex.raw(`
    ALTER TABLE app.bank_od_accounts
    SET SCHEMA app_test
  `);

}

export async function down(knex) {

  await knex.raw(`
    ALTER TABLE app_test.bank_od_accounts
    SET SCHEMA app
  `);

}