export async function up(knex) {
  await knex.schema.createTable(
    "push_journal_vouchers",
    (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable();

      table
        .string("company_name")
        .notNullable();

      table
        .date("voucher_date")
        .notNullable();

      table
        .string("voucher_number");

      table
        .string("voucher_type")
        .notNullable()
        .defaultTo("Journal");

      table
        .text("narration");

      table
        .string("status")
        .notNullable()
        .defaultTo("pending");

      table
        .text("error_message");

      table
        .integer("created_by");

      table.timestamps(true, true);
    }
  );
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(
    "push_journal_vouchers"
  );
}