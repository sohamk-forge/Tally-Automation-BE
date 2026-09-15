export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("vendor_gstin_mappings", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      // Purchase Report only carries Vendor Code / Vendor Name, never a
      // GSTIN — this is the one-time-mapped lookup pushInvoice.worker.js
      // (via bulkPurchase.worker.js) joins against to fill it in.
      table.text("vendor_code").notNullable();
      table.text("vendor_name");
      table.text("gstin");
      table.text("state");

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["company_id", "vendor_code"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("vendor_gstin_mappings");

}
