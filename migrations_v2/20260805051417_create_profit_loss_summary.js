import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  // Profit & Loss Summary (one row per company + reporting period)
  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("profit_loss_summary", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.string("company_name");

      table.date("from_date").notNullable();
      table.date("to_date").notNullable();

      table.unique(["company_id", "from_date", "to_date"]);

      // raw lines pulled from the Tally P&L report (for reference / audit)
      table.decimal("total_sales", 18, 2).defaultTo(0);
      table.decimal("total_purchase", 18, 2).defaultTo(0);
      table.decimal("opening_stock", 18, 2).defaultTo(0);
      table.decimal("closing_stock", 18, 2).defaultTo(0);
      table.decimal("direct_income", 18, 2).defaultTo(0);
      table.decimal("indirect_income", 18, 2).defaultTo(0);
      table.decimal("indirect_expenses", 18, 2).defaultTo(0);

      // the numbers that actually matter
      table.decimal("gross_profit", 18, 2).defaultTo(0);
      table.decimal("net_result", 18, 2).defaultTo(0);
      // net_result is SIGNED: positive = Nett Profit, negative = Nett Loss

      table.string("result_type").defaultTo("profit");
      // profit | loss

      table.decimal("profit_margin_percent", 8, 2).defaultTo(0);
      // net_result / total_sales * 100 (negative when result_type = loss)

      table.string("guid").notNullable();
      table.string("master_id");
      table.integer("alter_id").defaultTo(0);

      table.timestamps(true, true);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("profit_loss_summary");
}