import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("profit_loss", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.date("from_date");

      table.date("to_date");

      table.decimal("total_sales", 18, 2)
        .defaultTo(0);

      table.decimal("total_purchase", 18, 2)
        .defaultTo(0);

      table.decimal("stock_value", 18, 2)
        .defaultTo(0);

      table.decimal("gross_profit", 18, 2)
        .defaultTo(0);

      table.decimal("net_profit", 18, 2)
        .defaultTo(0);

      table.decimal("profit_margin", 18, 2)
        .defaultTo(0);

      table.timestamps(true, true);

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("profit_loss");

}