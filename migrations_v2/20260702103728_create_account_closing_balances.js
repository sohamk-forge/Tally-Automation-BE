/**
 * @param {import('knex')} knex
 */
export async function up(knex) {
  return knex.schema.createTable("account_closing_balances", (table) => {
    table.increments("id").primary();

    table.text("company_name").notNullable();
    table.text("balance_type").notNullable();

    table.decimal("closing_balance", 14, 2).defaultTo(0);

    table.timestamp("updated_at").defaultTo(knex.fn.now());

    table.unique(["company_name", "balance_type"]);
  });
}

/**
 * @param {import('knex')} knex
 */
export async function down(knex) {
  return knex.schema.dropTable("account_closing_balances");
}