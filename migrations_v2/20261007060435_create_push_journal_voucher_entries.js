export async function up(knex) {
  await knex.schema.createTable(
    "push_journal_voucher_entries",
    (table) => {
      table.increments("id").primary();

      table
        .integer("voucher_id")
        .notNullable()
        .references("id")
        .inTable("push_journal_vouchers")
        .onDelete("CASCADE");

      table
        .string("ledger_name")
        .notNullable();

      table
        .decimal("amount", 15, 2)
        .notNullable();

      table
        .string("entry_type")
        .notNullable();

      table.text("description");

      table.timestamps(true, true);
    }
  );
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(
    "push_journal_voucher_entries"
  );
}