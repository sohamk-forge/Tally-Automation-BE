
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema).createTable(
    "push_stock_journals",
    (table) => {
      table.increments("id").primary();
      table.integer("company_id").notNullable();
      table.string("company_name").notNullable();
      table.date("voucher_date").notNullable();
      table.string("voucher_number");
      table.string("voucher_type").notNullable().defaultTo("Stock Journal");
      table.text("narration");

      table.string("status").notNullable().defaultTo("pending");
      table.text("error_message");
      table.text("tally_response");
      table.integer("connector_job_id");
      table.integer("created_by");
      table.timestamps(true, true);

      table.index("company_id");
      table.index("status");
      table.index("connector_job_id");
    }
  );
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("push_stock_journals");
}

