export async function up(knex) {
  // Challan Header
  await knex.schema
    .withSchema("app_test")
    .createTable("challans", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("company_name");

      table.string("challan_number").notNullable();

      table.unique(["company_id", "challan_number"]);

      table.bigInteger("challan_seq").notNullable().defaultTo(1);

      table.date("challan_date").notNullable();

      table.string("customer_name");
      table.string("customer_gstin");
      table.string("customer_address");

      table.decimal("sub_total", 18, 2).defaultTo(0);
      table.decimal("total_cgst", 18, 2).defaultTo(0);
      table.decimal("total_sgst", 18, 2).defaultTo(0);
      table.decimal("total_igst", 18, 2).defaultTo(0);
      table.decimal("total_tax", 18, 2).defaultTo(0);
      table.decimal("grand_total", 18, 2).defaultTo(0);

      table.text("narration");

      table.string("status").defaultTo("DRAFT");

      table.timestamps(true, true);
    });

  // Challan Items
  await knex.schema
    .withSchema("app_test")
    .createTable("challan_items", (table) => {
      table.increments("id").primary();

      table
        .integer("challan_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.challans")
        .onDelete("CASCADE");

      table.string("item_name").notNullable();

      table.string("godown_name");

      table.string("hsn_code");

      table.decimal("qty", 18, 3).defaultTo(0);

      table.decimal("rate", 18, 2).defaultTo(0);

      table.string("gst_rate").defaultTo("0%");

      table.decimal("discount_percent", 5, 2).defaultTo(0);

      table.decimal("taxable_amount", 18, 2).defaultTo(0);

      table.decimal("cgst_amount", 18, 2).defaultTo(0);

      table.decimal("sgst_amount", 18, 2).defaultTo(0);

      table.decimal("igst_amount", 18, 2).defaultTo(0);

      table.decimal("line_total", 18, 2).defaultTo(0);

      table.integer("sort_order").defaultTo(0);

      table.timestamps(true, true);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("challan_items");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("challans");
}