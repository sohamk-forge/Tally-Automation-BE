export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  // ============================================================
  // GST GSTR-1 FILINGS
  // One row per save/file attempt for a company+GSTIN+period.
  // This is the audit trail + idempotency guard the master prompt
  // requires (PHASE 5/6): every save or file call must be traceable,
  // and accidental duplicate submissions must not create duplicate
  // filing attempts.
  // ============================================================
  await knex.schema
    .withSchema(schema)
    .createTable("gst_gstr1_filings", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable()
        .references("id")
        .inTable(`${schema}.companies`)
        .onDelete("CASCADE");

      table.string("gstin", 15).notNullable();
      table.string("financial_year", 9).notNullable(); // e.g. "2026-27"
      table.string("return_period", 10).notNullable(); // e.g. "08-2026"
      table.string("return_type", 10).notNullable().defaultTo("R1");

      // DRAFT_PENDING | DRAFT_SAVED | DRAFT_FAILED |
      // FILE_PENDING | FILED | FILE_FAILED
      table.string("status", 30).notNullable().defaultTo("DRAFT_PENDING");

      // Audit identifier for what was submitted, without necessarily
      // storing the full payload (master prompt: "payload hash or
      // equivalent audit identifier"). Full payload kept too during
      // early development for easier debugging — safe to prune later.
      table.text("payload_hash").nullable();
      table.jsonb("request_payload").nullable();
      table.jsonb("response_payload").nullable();
      table.jsonb("error_response").nullable();

      table.integer("invoice_count").nullable();

      // Acknowledgement Reference Number — returned by WhiteBooks on
      // successful filing. Never generated locally.
      table.text("arn").nullable();

      table.timestamp("requested_at", { useTz: true }).nullable();
      table.timestamp("responded_at", { useTz: true }).nullable();

      table
        .integer("created_by")
        .nullable()
        .references("id")
        .inTable(`${schema}.users`)
        .onDelete("SET NULL");

      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.index(
        ["company_id", "gstin", "financial_year", "return_period"],
        "idx_gstr1_filings_company_period"
      );

      // Idempotency guard: one row per company+gstin+period+type+status-family.
      // Enforced at the app layer (check-before-insert) rather than a hard
      // DB unique constraint here, since retries after a FAILED attempt are
      // legitimate and shouldn't be blocked by uniqueness — the app logic
      // decides whether an existing SAVED/FILED row means "don't resubmit".
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.schema.withSchema(schema).dropTableIfExists("gst_gstr1_filings");
}