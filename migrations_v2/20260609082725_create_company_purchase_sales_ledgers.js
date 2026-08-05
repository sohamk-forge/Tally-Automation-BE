import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("company_purchase_sales_ledgers", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.string("ledger_name").notNullable();

      table.string("parent_group");

      table.string("ledger_type"); // PURCHASE or SALES

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("company_purchase_sales_ledgers");

}