
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema).createTable(
    "push_stock_journal_entries",
    (table) => {
      table.increments("id").primary();

      table.integer("stock_journal_id").notNullable();
      table.string("stock_item_name").notNullable();
      table.decimal("quantity", 15, 3).notNullable();
      table.string("unit").notNullable();
      table.string("from_godown").notNullable();
      table.string("to_godown").notNullable();
      table.decimal("rate", 15, 2).notNullable();

      table.timestamps(true, true);

      table.foreign("stock_journal_id")
        .references("id")
        .inTable(`${schema}.push_stock_journals`)
        .onDelete("CASCADE");

      table.index("stock_journal_id");
    }
  );
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_stock_journal_entries");
}
