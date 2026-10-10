
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema).createTable("push_journal_vouchers", (table) => {
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
    table.text("tally_response");
    table.integer("connector_job_id");

    // Local numeric users.id (NOT the SuperTokens UUID).
    table.integer("created_by");

    table.timestamps(true, true);
  });

  await knex.raw(`
    CREATE INDEX idx_push_journal_vouchers_company
    ON ${schema}.push_journal_vouchers (company_id)
  `);

  await knex.raw(`
    CREATE INDEX idx_push_journal_vouchers_status
    ON ${schema}.push_journal_vouchers (status)
  `);

  await knex.raw(`
    CREATE INDEX idx_push_journal_vouchers_date
    ON ${schema}.push_journal_vouchers (voucher_date)
  `);

  await knex.raw(`
    CREATE INDEX idx_push_journal_vouchers_connector_job
    ON ${schema}.push_journal_vouchers (connector_job_id)
  `);

  // Foreign key uses the same schema.
  await knex.schema.withSchema(schema).alterTable("push_journal_vouchers", (table) => {
    table
      .foreign("created_by")
      .references("id")
      .inTable(`${schema}.users`)
      .onDelete("SET NULL");
  });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.raw(`
    DROP INDEX IF EXISTS ${schema}.idx_push_journal_vouchers_connector_job
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS ${schema}.idx_push_journal_vouchers_date
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS ${schema}.idx_push_journal_vouchers_status
  `);

  await knex.raw(`
    DROP INDEX IF EXISTS ${schema}.idx_push_journal_vouchers_company
  `);

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_journal_vouchers");
}
