export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("ocr_documents", (table) => {

      table.increments("id").primary();

      table.string("document_id");

      table.string("file_name");

      table.date("start_date");

      table.date("end_date");

      table.string("bank_ledger");

      table.string("bank_name");

      table.integer("total_transactions")
        .defaultTo(0);

      table.string("status")
        .defaultTo("Pending");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("ocr_documents");

}