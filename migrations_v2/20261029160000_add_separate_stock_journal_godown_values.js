
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema)
    .alterTable("push_stock_journal_entries", (table) => {
      table.string("from_unit");
      table.decimal("from_quantity", 15, 3);
      table.decimal("from_rate", 15, 2);

      table.string("to_unit");
      table.decimal("to_quantity", 15, 3);
      table.decimal("to_rate", 15, 2);
    });

  // Preserve existing rows by copying their old values
  // into the new source and destination columns.
  await knex.raw(`
    UPDATE "${schema}".push_stock_journal_entries
    SET
      from_unit = unit,
      from_quantity = quantity,
      from_rate = rate,
      to_unit = unit,
      to_quantity = quantity,
      to_rate = rate
  `);

  await knex.schema.withSchema(schema)
    .alterTable("push_stock_journal_entries", (table) => {
      table.string("from_unit").notNullable().alter();
      table.decimal("from_quantity", 15, 3).notNullable().alter();
      table.decimal("from_rate", 15, 2).notNullable().alter();

      table.string("to_unit").notNullable().alter();
      table.decimal("to_quantity", 15, 3).notNullable().alter();
      table.decimal("to_rate", 15, 2).notNullable().alter();
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema)
    .alterTable("push_stock_journal_entries", (table) => {
      table.dropColumn("from_unit");
      table.dropColumn("from_quantity");
      table.dropColumn("from_rate");

      table.dropColumn("to_unit");
      table.dropColumn("to_quantity");
      table.dropColumn("to_rate");
    });
}
