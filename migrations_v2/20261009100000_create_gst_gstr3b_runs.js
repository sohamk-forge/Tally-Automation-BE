// GSTR-3B, one row per company + GSTIN + return period: the prepared return
// (retsave body), liability / ITC / tax payment worked out from the books,
// and what later stages produce (portal comparison, save, offset, ARN).
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.schema.withSchema(schema).createTable("gst_gstr3b_runs", (table) => {
    table.increments("id").primary();
    table.integer("company_id").notNullable().references("id").inTable(`${schema}.companies`).onDelete("CASCADE");
    table.string("gstin", 15).notNullable();
    table.string("return_period", 7).notNullable(); // "06-2026"
    table.string("ret_period", 6).notNullable(); // "062026"

    // PREPARED | SAVED | OFFSET_DONE | FILED
    table.string("stage", 20).notNullable().defaultTo("PREPARED");

    table.jsonb("payload"); // retsave body
    table.jsonb("liability");
    table.jsonb("itc");
    table.jsonb("payment"); // ITC set-off + cash due
    table.jsonb("issues");
    table.jsonb("stats");
    table.timestamp("prepared_at", { useTz: true });

    table.jsonb("portal_autoliab");
    table.text("save_ref_id");
    table.jsonb("offset_status");
    table.jsonb("final_summary");
    table.text("arn");
    table.timestamp("filed_at", { useTz: true });

    table.integer("created_by").nullable().references("id").inTable(`${schema}.users`).onDelete("SET NULL");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["company_id", "gstin", "return_period"]);
  });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.schema.withSchema(schema).dropTableIfExists("gst_gstr3b_runs");
}
