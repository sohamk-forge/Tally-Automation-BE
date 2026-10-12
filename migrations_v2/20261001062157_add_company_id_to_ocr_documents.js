// migrations/xxxxxx_add_company_id_to_ocr_documents.js
//
// ocr_documents (bank-statement OCR, written by the unified-api service)
// had no company scoping at all — every endpoint keyed purely off
// document_id (the job UUID), so /documents and /ai-suggestions leaked
// every company's statements to any caller. This adds the same
// company_id FK pattern contra_vouchers already uses.
export async function up(knex) {
  const hasCompanyId = await knex.schema.withSchema("app_test").hasColumn("ocr_documents", "company_id");

  await knex.schema
    .withSchema("app_test")
    .alterTable("ocr_documents", (table) => {
      if (!hasCompanyId) {
        table
          .bigInteger("company_id")
          .references("id")
          .inTable("app_test.companies")
          .onUpdate("CASCADE")
          .onDelete("CASCADE");
      }
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("ocr_documents", (table) => {
      table.index(["company_id"], "idx_ocr_documents_company_id");
      table.index(["company_id", "status"], "idx_ocr_documents_company_status");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("ocr_documents", (table) => {
      table.dropIndex(["company_id"], "idx_ocr_documents_company_id");
      table.dropIndex(["company_id", "status"], "idx_ocr_documents_company_status");
      table.dropColumn("company_id");
    });
}
