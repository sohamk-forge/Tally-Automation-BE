/**
 * @param {import('knex')} knex
 */
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("account_closing_balances", (table) => {
    table.text("balance_type").notNullable().alter();
  });

  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    ADD CONSTRAINT acb_company_balance_unique
    UNIQUE (company_name, balance_type)
  `);
}

/**
 * @param {import('knex')} knex
 */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    DROP CONSTRAINT IF EXISTS acb_company_balance_unique
  `);

  await knex.schema.withSchema("app_test").alterTable("account_closing_balances", (table) => {
    table.text("balance_type").nullable().alter();
  });
}