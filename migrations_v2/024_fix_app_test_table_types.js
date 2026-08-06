export async function up(knex) {

  // Fix sales_items table - change quantity columns from NUMERIC to TEXT
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_items", (table) => {

      // Change actual_quantity from NUMERIC to TEXT
      table.text("actual_quantity").alter();
      
      // Change billed_quantity from NUMERIC to TEXT
      table.text("billed_quantity").alter();
      
      // Ensure billing is NUMERIC
      table.decimal("billing", 15, 2).alter();
      
      // Change company_name to TEXT
      table.text("company_name").alter();
      
      // Change voucher_number to TEXT
      table.text("voucher_number").alter();
    });

  // Drop company_id if it exists (old table doesn't have it)
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_items", (table) => {
      table.dropColumn("company_id");
    });

  // Fix vouchers table - change VARCHAR to TEXT
  await knex.schema
    .withSchema("app_test")
    .alterTable("vouchers", (table) => {
      table.text("company_name").alter();
      table.text("parent_group").alter();
      table.text("party_ledger_name").alter();
      table.text("voucher_number").alter();
      table.text("voucher_type").alter();
      table.text("narration").alter();
    });

  // Fix sundry_creditors table
  await knex.schema
    .withSchema("app_test")
    .alterTable("sundry_creditors", (table) => {
      table.text("company_name").alter();
      table.text("ledger_name").alter();
      table.text("parent_group").alter();
      table.text("address").alter();
      table.text("alias").alter();
      table.text("state").alter();
      table.text("country").alter();
      table.text("contact_name").alter();
    });

  // Fix sundry_debtors table
  await knex.schema
    .withSchema("app_test")
    .alterTable("sundry_debtors", (table) => {
      table.text("company_name").alter();
      table.text("ledger_name").alter();
      table.text("parent_group").alter();
      table.text("address").alter();
      table.text("alias").alter();
      table.text("state").alter();
      table.text("country").alter();
      table.text("contact_name").alter();
    });

  // Fix bank_accounts table
  await knex.schema
    .withSchema("app_test")
    .alterTable("bank_accounts", (table) => {
      table.text("company_name").alter();
      table.text("ledger_name").alter();
      table.text("parent_group").alter();
      table.text("account_holder_name").alter();
      table.text("account_number").alter();
      table.text("ifsc_code").alter();
      table.text("branch").alter();
      table.text("address").alter();
      table.text("state").alter();
      table.text("country").alter();
    });

  // Fix parent_groups table
  await knex.schema
    .withSchema("app_test")
    .alterTable("parent_groups", (table) => {
      table.text("company_name").alter();
      table.text("group_name").alter();
    });

  // Fix all_parent_groups table
  await knex.schema
    .withSchema("app_test")
    .alterTable("all_parent_groups", (table) => {
      table.text("company_name").alter();
      table.text("ledger_name").alter();
      table.text("parent_group").alter();
      table.text("address").alter();
      table.text("state").alter();
      table.text("country").alter();
      table.text("contact_name").alter();
    });

  // Fix stock_group_summary table
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.text("company_name").alter();
      table.text("group_name").alter();
      table.text("item_name").alter();
      table.text("hsn_code").alter();
    });
}

export async function down(knex) {

  // Revert sales_items table back to NUMERIC
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_items", (table) => {
      // Note: This will fail if data contains non-numeric values
      table.specificType("actual_quantity", "NUMERIC").alter();
      table.specificType("billed_quantity", "NUMERIC").alter();
    });

  // Revert vouchers table back to VARCHAR
  await knex.schema
    .withSchema("app_test")
    .alterTable("vouchers", (table) => {
      table.string("company_name").alter();
      table.string("parent_group").alter();
      table.string("party_ledger_name").alter();
      table.string("voucher_number").alter();
      table.string("voucher_type").alter();
      table.string("narration").alter();
    });

  // Add back company_id to sales_items
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_items", (table) => {
      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");
    });
}