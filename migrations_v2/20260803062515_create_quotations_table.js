import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  // Quotation Header
  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("quotations", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.string("company_name");

      table.string("quotation_number").notNullable();

      table.unique(["company_id", "quotation_number"]);

      table.bigInteger("quotation_seq").notNullable().defaultTo(1);

      table.date("quotation_date").notNullable();

      table.date("valid_until");

      table.string("customer_name");
      table.string("customer_gstin");
      table.string("customer_address");

      table.decimal("sub_total", 18, 2).defaultTo(0);
      table.decimal("total_cgst", 18, 2).defaultTo(0);
      table.decimal("total_sgst", 18, 2).defaultTo(0);
      table.decimal("total_igst", 18, 2).defaultTo(0);
      table.decimal("total_tax", 18, 2).defaultTo(0);
      table.decimal("grand_total", 18, 2).defaultTo(0);

      table.text("terms_conditions");

      table.string("status").defaultTo("DRAFT");
      // DRAFT | FINAL | PUSHED_TO_TALLY

      table.timestamp("pushed_to_tally_at");

      table.timestamps(true, true);
    });

  // Quotation Items
  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("quotation_items", (table) => {
      table.increments("id").primary();

      table
        .integer("quotation_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.quotations`)
        .onDelete("CASCADE");

      table.string("item_name").notNullable();

      table.string("godown_name");

      table.string("bin");

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
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("quotation_items");

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("quotations");
}