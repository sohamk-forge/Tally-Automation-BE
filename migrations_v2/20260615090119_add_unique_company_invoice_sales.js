export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_invoice_extractions", (table) => {
      table.unique(["company_id", "invoice_no"], "uq_company_invoice");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("sales_invoice_extractions", (table) => {
      table.dropUnique(["company_id", "invoice_no"], "uq_company_invoice");
    });
}