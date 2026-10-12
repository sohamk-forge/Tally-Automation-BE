// GSTR-1 filing runs (one per company + GSTIN + return period, carrying the
// pipeline's stage and everything each stage produced) and in-app HSN/rate
// overrides for items or ledgers whose Tally masters lack GST details.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema.withSchema(schema).createTable("gst_gstr1_runs", (table) => {
    table.increments("id").primary();
    table.integer("company_id").notNullable().references("id").inTable(`${schema}.companies`).onDelete("CASCADE");
    table.string("gstin", 15).notNullable();
    table.string("financial_year", 9).notNullable(); // "2026-27"
    table.string("return_period", 7).notNullable(); // "06-2026"
    table.string("ret_period", 6).notNullable(); // "062026", as sent to GSTN
    table.date("from_date").notNullable();
    table.date("to_date").notNullable();
    table.string("frequency", 10).notNullable().defaultTo("MONTHLY");

    // PREPARED | SAVED | SAVE_FAILED | VALIDATED | PROCEEDED | FILED
    table.string("stage", 20).notNullable().defaultTo("PREPARED");

    table.jsonb("payload"); // retsave body
    table.text("payload_hash");
    table.jsonb("sections"); // review-table rows
    table.jsonb("invoices"); // per-invoice breakdown for drill-down
    table.jsonb("excluded"); // vouchers left out, with reason
    table.jsonb("issues");
    table.jsonb("stats");
    table.integer("error_count").notNullable().defaultTo(0);
    table.integer("warning_count").notNullable().defaultTo(0);
    table.timestamp("prepared_at", { useTz: true });

    // later stages
    table.text("save_ref_id");
    table.jsonb("save_status");
    table.text("proceed_ref_id");
    table.jsonb("final_summary");
    table.text("arn");
    table.timestamp("filed_at", { useTz: true });

    table.integer("created_by").nullable().references("id").inTable(`${schema}.users`).onDelete("SET NULL");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["company_id", "gstin", "return_period"]);
  });

  await knex.schema.withSchema(schema).createTable("gst_item_hsn_overrides", (table) => {
    table.increments("id").primary();
    table.integer("company_id").notNullable().references("id").inTable(`${schema}.companies`).onDelete("CASCADE");
    table.text("item_name").notNullable(); // stock item or sales ledger name as in Tally
    table.text("item_key").notNullable(); // lower-cased, whitespace-collapsed
    table.string("hsn_code", 8);
    table.decimal("gst_rate", 5, 2);
    table.string("uqc", 3);
    table.integer("updated_by").nullable().references("id").inTable(`${schema}.users`).onDelete("SET NULL");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["company_id", "item_key"]);
  });

  // HSN digits required for this GSTIN: 6 above ₹5 crore turnover, else 4.
  await knex.raw(`ALTER TABLE ${schema}.gst_credentials ADD COLUMN IF NOT EXISTS hsn_min_digits SMALLINT NOT NULL DEFAULT 6`);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`ALTER TABLE ${schema}.gst_credentials DROP COLUMN IF EXISTS hsn_min_digits`);
  await knex.schema.withSchema(schema).dropTableIfExists("gst_item_hsn_overrides");
  await knex.schema.withSchema(schema).dropTableIfExists("gst_gstr1_runs");
}
