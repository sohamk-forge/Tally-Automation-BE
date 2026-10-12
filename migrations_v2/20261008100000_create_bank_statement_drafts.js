/**
 * Unsent Review Statement picks (party ledger / voucher type / edited
 * narration) per transaction row, so a user's selections survive leaving
 * the page, a refresh, or switching machines until they are pushed to Tally.
 *
 * statement_key is "excel:<file_name>" or "pdf:<document_id>" — PDF rows
 * live in the OCR service, so drafts can't hang off contra_vouchers.
 */

export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .createTable("bank_statement_drafts", (table) => {
      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.text("statement_key").notNullable();
      table.text("row_id").notNullable();

      table.text("ledger");
      table.text("voucher");
      table.text("narration");

      table.integer("updated_by");

      table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
      table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();

      table.unique(["company_id", "statement_key", "row_id"]);
      table.index(["company_id", "statement_key"]);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("bank_statement_drafts");
}
