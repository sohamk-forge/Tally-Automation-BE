export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .createTable("push_journal_voucher_entries", (table) => {
      table.increments("id").primary();

      table
        .integer("voucher_id")
        .notNullable()
        .references("id")
        .inTable(`${schema}.push_journal_vouchers`)
        .onDelete("CASCADE");

      table.string("ledger_name").notNullable();

      table.decimal("amount", 15, 2).notNullable();

      table.string("entry_type").notNullable();

      table.text("description");

      table.timestamps(true, true);

      table.index(["voucher_id"], "idx_push_journal_entries_voucher");
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_journal_voucher_entries");
}
