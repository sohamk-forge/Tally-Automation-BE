import { DB_SCHEMA } from "../src/config/db.js";
/**
 * @param {import('knex')} knex
 */
export async function up(knex) {
  await knex.schema.withSchema(DB_SCHEMA).alterTable("account_closing_balances", (table) => {
    table.text("balance_type").notNullable().alter();
  });

  await knex.raw(`
    ALTER TABLE ${DB_SCHEMA}.account_closing_balances
    ADD CONSTRAINT acb_company_balance_unique
    UNIQUE (company_name, balance_type)
  `);
}

/**
 * @param {import('knex')} knex
 */
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE ${DB_SCHEMA}.account_closing_balances
    DROP CONSTRAINT IF EXISTS acb_company_balance_unique
  `);

  await knex.schema.withSchema(DB_SCHEMA).alterTable("account_closing_balances", (table) => {
    table.text("balance_type").nullable().alter();
  });
}