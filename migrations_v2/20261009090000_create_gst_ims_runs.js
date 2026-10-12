// IMS / GSTR-2B step, one row per company + GSTIN + return period: the IMS
// invoices fetched from the portal with their match against purchase
// vouchers, the user's action overrides, and what later stages produce
// (IMS save reference, 2B generation, the 2B statement).
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.schema.withSchema(schema).createTable("gst_ims_runs", (table) => {
    table.increments("id").primary();
    table.integer("company_id").notNullable().references("id").inTable(`${schema}.companies`).onDelete("CASCADE");
    table.string("gstin", 15).notNullable();
    table.string("return_period", 7).notNullable(); // "06-2026"
    table.string("ret_period", 6).notNullable(); // "062026"
    table.date("from_date").notNullable();
    table.date("to_date").notNullable();

    // FETCHED | SAVED | SAVE_FAILED | GSTR2B_GENERATED | VERIFIED
    table.string("stage", 20).notNullable().defaultTo("FETCHED");

    table.jsonb("rows"); // IMS invoices + match result + proposed action
    table.jsonb("decisions"); // { [rowKey]: "A" | "R" | "P" } — user overrides
    table.jsonb("only_in_books"); // purchases in the period with no IMS invoice
    table.jsonb("warnings");
    table.jsonb("stats");
    table.timestamp("fetched_at", { useTz: true });

    table.text("save_ref_id");
    table.jsonb("save_status");
    table.text("gen2b_ref_id");
    table.jsonb("gstr2b");
    table.timestamp("verified_at", { useTz: true });

    table.integer("created_by").nullable().references("id").inTable(`${schema}.users`).onDelete("SET NULL");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["company_id", "gstin", "return_period"]);
  });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.schema.withSchema(schema).dropTableIfExists("gst_ims_runs");
}
