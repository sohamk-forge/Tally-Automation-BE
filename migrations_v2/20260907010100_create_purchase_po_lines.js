export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("purchase_po_lines", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.integer("user_id")
        .unsigned()
        .references("id")
        .inTable("app_test.users")
        .onDelete("SET NULL");

      // Identity of a single PO line item, stable across re-uploads of the
      // same month's Purchase Report.
      table.text("po_no").notNullable();
      table.text("po_line_item").notNullable();
      table.date("po_date");

      // Reconciliation key against the Spare Statement's "Ref. Doc No.".
      table.text("odn");
      table.text("inbound_delivery_no");

      table.text("vendor_code");
      table.text("vendor_name");

      table.text("material_code");
      table.text("material_description");
      table.text("hsn_code");
      table.decimal("quantity", 14, 3);
      table.text("unit");
      table.decimal("amount", 14, 2);
      table.decimal("taxable_amount", 14, 2);
      table.decimal("tax_amount", 14, 2);
      table.text("tax_description");

      table.text("godown_name");

      // Filled once resolved, either directly from the report or via a
      // later Spare Statement match.
      table.text("invoice_no");
      table.text("invoice_date");

      table.text("match_status").notNullable().defaultTo("pending_dispatch");
      // pending_dispatch | matched | pushed

      table.integer("invoice_extraction_id")
        .unsigned()
        .references("id")
        .inTable("app_test.invoice_extractions")
        .onDelete("SET NULL");

      table.text("source_batch_id");

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      // Re-uploading the same month's report updates these rows instead of
      // duplicating them.
      table.unique(["company_id", "po_no", "po_line_item"]);

    });

  // Every future Spare Statement upload scans the pending backlog by ODN —
  // this is the lookup that query runs, across potentially many months.
  await knex.schema
    .withSchema("app_test")
    .raw(`
      CREATE INDEX purchase_po_lines_pending_odn_idx
      ON app_test.purchase_po_lines (company_id, match_status, odn)
      WHERE match_status = 'pending_dispatch'
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("purchase_po_lines");

}
