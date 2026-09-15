export async function up(knex) {

  // A durable index of every Spare Statement row ever uploaded, so a
  // Purchase Report line can be matched against a statement that arrived
  // BEFORE it (not just backlog re-checked after the fact when a statement
  // shows up later). Without this, "already backfilled by an earlier
  // statement" (see bulkPurchase.worker.js) would only ever look at
  // in-memory state from the current job, not anything persisted.
  await knex.schema
    .withSchema("app_test")
    .createTable("spare_statement_entries", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.text("ref_doc_no").notNullable();
      table.text("invoice_no").notNullable();
      table.text("posting_date");
      table.text("doc_type");

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();

      // A given Ref. Doc No. is re-uploaded verbatim across statements that
      // overlap in date range — upsert rather than duplicate.
      table.unique(["company_id", "ref_doc_no"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("spare_statement_entries");

}
