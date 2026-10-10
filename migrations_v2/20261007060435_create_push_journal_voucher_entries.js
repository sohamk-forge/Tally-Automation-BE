
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema).createTable("push_journal_voucher_entries", (table) => {
    table.increments("id").primary();

    table.integer("voucher_id").notNullable();

    table.string("ledger_name").notNullable();

    table.decimal("amount", 15, 2).notNullable();

    table.string("entry_type").notNullable();

    table.text("description");

    table.timestamps(true, true);
  });

  // Foreign key using the configured schema.
  await knex.schema.withSchema(schema).alterTable("push_journal_voucher_entries", (table) => {
    table
      .foreign("voucher_id")
      .references("id")
      .inTable(`${schema}.push_journal_vouchers`)
      .onDelete("CASCADE");
  });

  // Index for voucher_id.
  await knex.raw(`
    CREATE INDEX idx_push_journal_entries_voucher
    ON ${schema}.push_journal_voucher_entries (voucher_id)
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.raw(`
    DROP INDEX IF EXISTS ${schema}.idx_push_journal_entries_voucher
  `);

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_journal_voucher_entries");
}
