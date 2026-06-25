export async function up(knex) {

  // USERS
  await knex.schema.withSchema("app_test")
    .table("users", (table) => {

      table.index(["email"]);

    });

  // COMPANIES
  await knex.schema.withSchema("app_test")
    .table("companies", (table) => {

      table.index(["name"]);

      table.index(["guid"]);

    });

  // LEDGERS
  await knex.schema.withSchema("app_test")
    .table("ledgers", (table) => {

      table.index(["company_id"]);

      table.index(["name"]);

      table.index(["parent_group"]);

      table.index(["guid"]);

      table.index(["master_id"]);

    });

  // BANK ACCOUNTS
  await knex.schema.withSchema("app_test")
    .table("bank_accounts", (table) => {

      table.index(["company_id"]);

      table.index(["ledger_name"]);

      table.index(["account_number"]);

    });

  // PARENT GROUPS
  await knex.schema.withSchema("app_test")
    .table("parent_groups", (table) => {

      table.index(["company_id"]);

      table.index(["group_name"]);

    });

  // ALL PARENT GROUPS
  await knex.schema.withSchema("app_test")
    .table("all_parent_groups", (table) => {

      table.index(["company_id"]);

      table.index(["parent_group"]);

      table.index(["ledger_name"]);

    });

  // VOUCHERS
  await knex.schema.withSchema("app_test")
    .table("vouchers", (table) => {

      table.index(["company_id"]);

      table.index(["voucher_date"]);

      table.index(["voucher_type"]);

      table.index(["voucher_number"]);

      table.index(["party_ledger_name"]);

    });

  // STOCK ITEMS
  await knex.schema.withSchema("app_test")
    .table("stock_items", (table) => {

      table.index(["company_id"]);

      table.index(["name"]);

    });

  // STOCK GROUP SUMMARY
  await knex.schema.withSchema("app_test")
    .table("stock_group_summary", (table) => {

      table.index(["company_id"]);

      table.index(["group_name"]);

      table.index(["item_name"]);

    });

  // PUSH LEDGER
  await knex.schema.withSchema("app_test")
    .table("push_ledger", (table) => {

      table.index(["company_id"]);

      table.index(["ledger_name"]);

      table.index(["status"]);

    });

  // AUDIT LOGS
  await knex.schema.withSchema("app_test")
    .table("audit_logs", (table) => {

      table.index(["user_id"]);

      table.index(["entity"]);

      table.index(["created_at"]);

    });

  // JOB LOGS
  await knex.schema.withSchema("app_test")
    .table("job_logs", (table) => {

      table.index(["user_id"]);

      table.index(["job_type"]);

      table.index(["status"]);

    });

}

export async function down(knex) {

}