
export async function up(knex) {
  // ============================================================
  // 1. Add unit to existing quotation_items table
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .alterTable("quotation_items", (table) => {
      table.text("unit");
    });

  // ============================================================
  // 2. Add quotation versioning
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .alterTable("quotations", (table) => {
      table
        .integer("root_quotation_id")
        .references("id")
        .inTable("app_test.quotations");

      table
        .integer("version_seq")
        .notNullable()
        .defaultTo(0);

      table
        .integer("parent_quotation_id")
        .references("id")
        .inTable("app_test.quotations");
    });

  // Existing quotations become their own root
  await knex("app_test.quotations")
    .whereNull("root_quotation_id")
    .update({
      root_quotation_id: knex.raw("id"),
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("quotations", (table) => {
      table.integer("root_quotation_id").notNullable().alter();
    });

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_quotations_root_version
    ON app_test.quotations (root_quotation_id, version_seq)
  `);

  // ============================================================
  // 3. Proforma invoices
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .createTable("proforma_invoices", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable();

      table.string("company_name");

      table.string("proforma_number").notNullable();

      table.integer("proforma_seq").notNullable();

      table
        .integer("quotation_id")
        .references("id")
        .inTable("app_test.quotations");

      table.date("proforma_date").notNullable();

      table.date("valid_until");

      table.string("customer_name");
      table.string("customer_gstin");
      table.text("customer_address");

      table.decimal("sub_total", 14, 2).defaultTo(0);
      table.decimal("total_cgst", 14, 2).defaultTo(0);
      table.decimal("total_sgst", 14, 2).defaultTo(0);
      table.decimal("total_igst", 14, 2).defaultTo(0);
      table.decimal("total_tax", 14, 2).defaultTo(0);
      table.decimal("grand_total", 14, 2).defaultTo(0);

      table.text("terms_conditions");

      table.string("status").notNullable().defaultTo("DRAFT");

      table.timestamps(true, true);

      table.unique(["company_id", "proforma_seq"]);
    });

  // ============================================================
  // 4. Proforma invoice items
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .createTable("proforma_invoice_items", (table) => {
      table.increments("id").primary();

      table
        .integer("proforma_invoice_id")
        .references("id")
        .inTable("app_test.proforma_invoices")
        .onDelete("CASCADE");

      table.string("item_name").notNullable();

      table.string("godown_name");
      table.string("bin");
      table.string("hsn_code");
      table.string("unit");

      table.decimal("qty", 14, 2);
      table.decimal("rate", 14, 2);

      table.string("gst_rate");

      table.decimal("discount_percent", 6, 2);

      table.decimal("taxable_amount", 14, 2);
      table.decimal("cgst_amount", 14, 2);
      table.decimal("sgst_amount", 14, 2);
      table.decimal("igst_amount", 14, 2);
      table.decimal("line_total", 14, 2);

      table.integer("sort_order");
    });

  // ============================================================
  // 5. Sales invoices
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .createTable("sales_invoices", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable();

      table.string("company_name");

      table.string("invoice_number").notNullable();

      table.integer("invoice_seq").notNullable();

      table
        .integer("proforma_invoice_id")
        .references("id")
        .inTable("app_test.proforma_invoices");

      table
        .integer("quotation_id")
        .references("id")
        .inTable("app_test.quotations");

      table.date("invoice_date").notNullable();

      table.date("due_date");

      table.string("customer_name");
      table.string("customer_gstin");
      table.text("customer_address");

      table.decimal("sub_total", 14, 2).defaultTo(0);
      table.decimal("total_cgst", 14, 2).defaultTo(0);
      table.decimal("total_sgst", 14, 2).defaultTo(0);
      table.decimal("total_igst", 14, 2).defaultTo(0);
      table.decimal("total_tax", 14, 2).defaultTo(0);
      table.decimal("grand_total", 14, 2).defaultTo(0);

      table.text("terms_conditions");

      table.string("status").notNullable().defaultTo("DRAFT");

      table.timestamps(true, true);

      table.unique(["company_id", "invoice_seq"]);
    });

  // ============================================================
  // 6. Sales invoice items
  // ============================================================

  await knex.schema
    .withSchema("app_test")
    .createTable("sales_invoice_items", (table) => {
      table.increments("id").primary();

      table
        .integer("sales_invoice_id")
        .references("id")
        .inTable("app_test.sales_invoices")
        .onDelete("CASCADE");

      table.string("item_name").notNullable();

      table.string("godown_name");
      table.string("bin");
      table.string("hsn_code");
      table.string("unit");

      table.decimal("qty", 14, 2);
      table.decimal("rate", 14, 2);

      table.string("gst_rate");

      table.decimal("discount_percent", 6, 2);

      table.decimal("taxable_amount", 14, 2);
      table.decimal("cgst_amount", 14, 2);
      table.decimal("sgst_amount", 14, 2);
      table.decimal("igst_amount", 14, 2);
      table.decimal("line_total", 14, 2);

      table.integer("sort_order");
    });
}

export async function down(knex) {
  // Drop in reverse dependency order

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("sales_invoice_items");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("sales_invoices");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("proforma_invoice_items");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("proforma_invoices");

  await knex.schema.raw(`
    DROP INDEX IF EXISTS app_test.idx_quotations_root_version
  `);

  await knex.schema
    .withSchema("app_test")
    .alterTable("quotations", (table) => {
      table.dropColumn("parent_quotation_id");
      table.dropColumn("version_seq");
      table.dropColumn("root_quotation_id");
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("quotation_items", (table) => {
      table.dropColumn("unit");
    });
}
