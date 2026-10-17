/**
 * The financial years a company has been synced for. One company can hold several (a customer who syncs
 * 1-Oct-2026 to 31-Mar-2028 gets 2026-27 and 2027-28), so the company list can offer a financial-year
 * filter instead of assuming a single start/end year.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").createTable("company_financial_years", (table) => {
    table.increments("id").primary();
    table.integer("company_id").notNullable().references("id").inTable("app_test.companies").onDelete("CASCADE");
    table.integer("start_year").notNullable();
    table.date("from_date").notNullable();
    table.date("to_date").notNullable();
    table.timestamp("synced_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["company_id", "start_year"]);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").dropTableIfExists("company_financial_years");
}
