import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  // =========================
  // FOREIGN KEYS ONLY
  // =========================

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("all_ledger_details", (table) => {

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_stock_item", (table) => {

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("units", (table) => {

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

  // =========================
  // ADD COLUMN + FK
  // =========================

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("bank_od_accounts", (table) => {

      table.integer("company_id")
        .unsigned();

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("invoice_extractions", (table) => {

      table.integer("company_id")
        .unsigned();

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_bank", (table) => {

      table.integer("company_id")
        .unsigned();

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("all_ledger_details", (table) => {

      table.dropForeign("company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_stock_item", (table) => {

      table.dropForeign("company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("units", (table) => {

      table.dropForeign("company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("bank_od_accounts", (table) => {

      table.dropForeign("company_id");
      table.dropColumn("company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("invoice_extractions", (table) => {

      table.dropForeign("company_id");
      table.dropColumn("company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("push_bank", (table) => {

      table.dropForeign("company_id");
      table.dropColumn("company_id");

    });

}