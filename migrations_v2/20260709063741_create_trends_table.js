export function up(knex) {
  return knex.schema.withSchema("app_test").createTable("trends", (table) => {
    table.increments("id").primary();
    table.string("company_name").notNullable();
    table.string("cache_key").notNullable(); // 'top_sales_ledgers' | 'sales_purchase_trend' | 'monthly_sales_trend'
    table.jsonb("data").notNullable();
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["company_name", "cache_key"]);
  });
}

export function down(knex) {
  return knex.schema.withSchema("app_test").dropTableIfExists("trends");
}