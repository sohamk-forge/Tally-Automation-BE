/**
 * Add indexes and unique constraints for performance
 * Run: npx knex migrate:latest
 */

export async function up(knex) {
  // ===================================================
  // APP.COMPANIES
  // ===================================================
  await knex.schema.withSchema("app").alterTable("companies", (table) => {
    table.index(["guid"], "idx_companies_guid");
    table.index(["name"], "idx_companies_name");
    table.unique(["guid"], "uq_companies_guid");
    table.unique(["name"], "uq_companies_name");
  });

  // ===================================================
  // APP.LEDGERS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("ledgers", (table) => {
    table.index(["company_id"], "idx_ledgers_company_id");
    table.index(["guid"], "idx_ledgers_guid");
    table.index(["name"], "idx_ledgers_name");
    table.index(["parent_group"], "idx_ledgers_parent_group");
    table.index(["gst_number"], "idx_ledgers_gst_number");
    table.unique(["guid"], "uq_ledgers_guid");
    table.unique(["company_id", "name"], "uq_ledgers_company_name");
  });

  // ===================================================
  // APP.SUNDRY_CREDITORS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("sundry_creditors", (table) => {
    table.index(["company_id"], "idx_creditors_company_id");
    table.index(["guid"], "idx_creditors_guid");
    table.index(["ledger_name"], "idx_creditors_ledger_name");
    table.index(["gst_number"], "idx_creditors_gst_number");
    table.unique(["guid"], "uq_creditors_guid");
    table.unique(["company_id", "ledger_name"], "uq_creditors_company_ledger");
  });

  // ===================================================
  // APP.SUNDRY_DEBTORS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("sundry_debtors", (table) => {
    table.index(["company_id"], "idx_debtors_company_id");
    table.index(["guid"], "idx_debtors_guid");
    table.index(["ledger_name"], "idx_debtors_ledger_name");
    table.index(["gst_number"], "idx_debtors_gst_number");
    table.unique(["guid"], "uq_debtors_guid");
    table.unique(["company_id", "ledger_name"], "uq_debtors_company_ledger");
  });

  // ===================================================
  // APP.BANK_ACCOUNTS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("bank_accounts", (table) => {
    table.index(["company_id"], "idx_bank_company_id");
    table.index(["guid"], "idx_bank_guid");
    table.index(["ledger_name"], "idx_bank_ledger_name");
    table.index(["account_number"], "idx_bank_account_number");
    table.unique(["guid"], "uq_bank_guid");
    table.unique(["company_id", "ledger_name"], "uq_bank_company_ledger");
  });

  // ===================================================
  // APP.VOUCHERS (CRITICAL - MOST QUERIED)
  // ===================================================
  await knex.schema.withSchema("app").alterTable("vouchers", (table) => {
    // Single column indexes
    table.index(["company_id"], "idx_vouchers_company_id");
    table.index(["guid"], "idx_vouchers_guid");
    table.index(["voucher_date"], "idx_vouchers_date");
    table.index(["voucher_number"], "idx_vouchers_number");
    table.index(["voucher_type"], "idx_vouchers_type");
    table.index(["party_ledger_name"], "idx_vouchers_party");
    
    // Composite indexes for common query patterns
    table.index(
      ["company_id", "voucher_date"], 
      "idx_vouchers_company_date"
    );
    table.index(
      ["company_id", "voucher_type", "voucher_date"], 
      "idx_vouchers_company_type_date"
    );
    table.index(
      ["company_id", "party_ledger_name", "voucher_date"], 
      "idx_vouchers_company_party_date"
    );
    
    // Unique constraints
    table.unique(["guid"], "uq_vouchers_guid");
    table.unique(
      ["company_id", "voucher_number", "voucher_date"], 
      "uq_vouchers_company_number_date"
    );
  });

  // ===================================================
  // APP.PARENT_GROUPS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("parent_groups", (table) => {
    table.index(["company_id"], "idx_parentgroups_company_id");
    table.index(["guid"], "idx_parentgroups_guid");
    table.index(["group_name"], "idx_parentgroups_name");
    table.unique(["guid"], "uq_parentgroups_guid");
    table.unique(["company_id", "group_name"], "uq_parentgroups_company_name");
  });

  // ===================================================
  // APP.GROUP_BALANCES
  // ===================================================
  await knex.schema.withSchema("app").alterTable("group_balances", (table) => {
    table.index(["company_id"], "idx_groupbalances_company_id");
    table.index(["guid"], "idx_groupbalances_guid");
    table.index(["group_name"], "idx_groupbalances_name");
    table.unique(["guid"], "uq_groupbalances_guid");
    table.unique(["company_id", "group_name"], "uq_groupbalances_company_name");
  });

  // ===================================================
  // APP.ALL_PARENT_GROUPS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("all_parent_groups", (table) => {
    table.index(["company_id"], "idx_allparent_company_id");
    table.index(["guid"], "idx_allparent_guid");
    table.index(["ledger_name"], "idx_allparent_ledger_name");
    table.index(["parent_group"], "idx_allparent_parent_group");
    table.index(["gst_number"], "idx_allparent_gst_number");
    table.unique(["guid"], "uq_allparent_guid");
    table.unique(
      ["company_id", "parent_group", "ledger_name"], 
      "uq_allparent_company_parent_ledger"
    );
  });

  // ===================================================
  // APP.PROFIT_LOSS
  // ===================================================
  await knex.schema.withSchema("app").alterTable("profit_loss", (table) => {
    table.index(["company_id"], "idx_profitloss_company_id");
    table.index(["guid"], "idx_profitloss_guid");
    table.index(["from_date", "to_date"], "idx_profitloss_dates");
    table.unique(["guid"], "uq_profitloss_guid");
    table.unique(
      ["company_id", "from_date", "to_date"], 
      "uq_profitloss_company_dates"
    );
  });
}

export async function down(knex) {
  // Remove all indexes and constraints (rollback)
  
  // Companies
  await knex.schema.withSchema("app").alterTable("companies", (table) => {
    table.dropIndex(["guid"], "idx_companies_guid");
    table.dropIndex(["name"], "idx_companies_name");
    table.dropUnique(["guid"], "uq_companies_guid");
    table.dropUnique(["name"], "uq_companies_name");
  });

  // Ledgers
  await knex.schema.withSchema("app").alterTable("ledgers", (table) => {
    table.dropIndex(["company_id"], "idx_ledgers_company_id");
    table.dropIndex(["guid"], "idx_ledgers_guid");
    table.dropIndex(["name"], "idx_ledgers_name");
    table.dropIndex(["parent_group"], "idx_ledgers_parent_group");
    table.dropIndex(["gst_number"], "idx_ledgers_gst_number");
    table.dropUnique(["guid"], "uq_ledgers_guid");
    table.dropUnique(["company_id", "name"], "uq_ledgers_company_name");
  });

  // Creditors
  await knex.schema.withSchema("app").alterTable("sundry_creditors", (table) => {
    table.dropIndex(["company_id"], "idx_creditors_company_id");
    table.dropIndex(["guid"], "idx_creditors_guid");
    table.dropIndex(["ledger_name"], "idx_creditors_ledger_name");
    table.dropIndex(["gst_number"], "idx_creditors_gst_number");
    table.dropUnique(["guid"], "uq_creditors_guid");
    table.dropUnique(["company_id", "ledger_name"], "uq_creditors_company_ledger");
  });

  // Debtors
  await knex.schema.withSchema("app").alterTable("sundry_debtors", (table) => {
    table.dropIndex(["company_id"], "idx_debtors_company_id");
    table.dropIndex(["guid"], "idx_debtors_guid");
    table.dropIndex(["ledger_name"], "idx_debtors_ledger_name");
    table.dropIndex(["gst_number"], "idx_debtors_gst_number");
    table.dropUnique(["guid"], "uq_debtors_guid");
    table.dropUnique(["company_id", "ledger_name"], "uq_debtors_company_ledger");
  });

  // Bank Accounts
  await knex.schema.withSchema("app").alterTable("bank_accounts", (table) => {
    table.dropIndex(["company_id"], "idx_bank_company_id");
    table.dropIndex(["guid"], "idx_bank_guid");
    table.dropIndex(["ledger_name"], "idx_bank_ledger_name");
    table.dropIndex(["account_number"], "idx_bank_account_number");
    table.dropUnique(["guid"], "uq_bank_guid");
    table.dropUnique(["company_id", "ledger_name"], "uq_bank_company_ledger");
  });

  // Vouchers
  await knex.schema.withSchema("app").alterTable("vouchers", (table) => {
    table.dropIndex(["company_id"], "idx_vouchers_company_id");
    table.dropIndex(["guid"], "idx_vouchers_guid");
    table.dropIndex(["voucher_date"], "idx_vouchers_date");
    table.dropIndex(["voucher_number"], "idx_vouchers_number");
    table.dropIndex(["voucher_type"], "idx_vouchers_type");
    table.dropIndex(["party_ledger_name"], "idx_vouchers_party");
    table.dropIndex(["company_id", "voucher_date"], "idx_vouchers_company_date");
    table.dropIndex(["company_id", "voucher_type", "voucher_date"], "idx_vouchers_company_type_date");
    table.dropIndex(["company_id", "party_ledger_name", "voucher_date"], "idx_vouchers_company_party_date");
    table.dropUnique(["guid"], "uq_vouchers_guid");
    table.dropUnique(["company_id", "voucher_number", "voucher_date"], "uq_vouchers_company_number_date");
  });

  // Parent Groups
  await knex.schema.withSchema("app").alterTable("parent_groups", (table) => {
    table.dropIndex(["company_id"], "idx_parentgroups_company_id");
    table.dropIndex(["guid"], "idx_parentgroups_guid");
    table.dropIndex(["group_name"], "idx_parentgroups_name");
    table.dropUnique(["guid"], "uq_parentgroups_guid");
    table.dropUnique(["company_id", "group_name"], "uq_parentgroups_company_name");
  });

  // Group Balances
  await knex.schema.withSchema("app").alterTable("group_balances", (table) => {
    table.dropIndex(["company_id"], "idx_groupbalances_company_id");
    table.dropIndex(["guid"], "idx_groupbalances_guid");
    table.dropIndex(["group_name"], "idx_groupbalances_name");
    table.dropUnique(["guid"], "uq_groupbalances_guid");
    table.dropUnique(["company_id", "group_name"], "uq_groupbalances_company_name");
  });

  // All Parent Groups
  await knex.schema.withSchema("app").alterTable("all_parent_groups", (table) => {
    table.dropIndex(["company_id"], "idx_allparent_company_id");
    table.dropIndex(["guid"], "idx_allparent_guid");
    table.dropIndex(["ledger_name"], "idx_allparent_ledger_name");
    table.dropIndex(["parent_group"], "idx_allparent_parent_group");
    table.dropIndex(["gst_number"], "idx_allparent_gst_number");
    table.dropUnique(["guid"], "uq_allparent_guid");
    table.dropUnique(["company_id", "parent_group", "ledger_name"], "uq_allparent_company_parent_ledger");
  });

  // Profit Loss
  await knex.schema.withSchema("app").alterTable("profit_loss", (table) => {
    table.dropIndex(["company_id"], "idx_profitloss_company_id");
    table.dropIndex(["guid"], "idx_profitloss_guid");
    table.dropIndex(["from_date", "to_date"], "idx_profitloss_dates");
    table.dropUnique(["guid"], "uq_profitloss_guid");
    table.dropUnique(["company_id", "from_date", "to_date"], "uq_profitloss_company_dates");
  });
}