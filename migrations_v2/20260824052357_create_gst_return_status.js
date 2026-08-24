export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .createTable("gst_return_status", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable()
        .references("id")
        .inTable(`${schema}.companies`)
        .onDelete("CASCADE");

      table.string("gstin", 15).notNullable();

      table.string("financial_year", 9).nullable();

      table.string("return_period", 10).nullable();

      table.string("frequency", 20).nullable();

      table.boolean("previous_return_filed").nullable();

      table.string("status", 30).notNullable().defaultTo("PENDING");

      table.text("txn_id").nullable();

      table.text("ref_id").nullable();

      table.jsonb("raw_response").nullable();

      table
        .timestamp("checked_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.index(
        ["company_id", "gstin", "id"],
        "idx_gst_return_status_company_gstin"
      );
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("gst_return_status");
}