export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .createTable("push_journal_vouchers", (table) => {
      table.increments("id").primary();

      table.integer("company_id").notNullable();

      table.string("company_name").notNullable();

      table.date("voucher_date").notNullable();

      table.string("voucher_number");

      table.string("voucher_type").notNullable().defaultTo("Journal");

      table.text("narration");

      // pending -> processing -> pending_connector -> success | failed
      table.string("status").notNullable().defaultTo("pending");

      table.text("error_message");

      // Raw Tally import response, kept for debugging rejected vouchers.
      table.text("tally_response");

      // Set once the worker has handed the voucher to the connector, so a
      // BullMQ retry never creates a second connector job (= a duplicate
      // journal in Tally).
      table.integer("connector_job_id");

      // Local numeric app_test.users.id (NOT the SuperTokens UUID).
      table.integer("created_by");

      table.timestamps(true, true);

      table.index(["company_id"], "idx_push_journal_vouchers_company");
      table.index(["status"], "idx_push_journal_vouchers_status");
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_journal_vouchers");
}
