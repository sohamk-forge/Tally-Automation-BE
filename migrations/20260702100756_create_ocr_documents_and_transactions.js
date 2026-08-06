export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("ocr_documents", (table) => {

      table.increments("id").primary();

      table.uuid("document_id")
        .notNullable()
        .unique();

      table.string("bank_name")
        .notNullable();

      table.integer("total_transactions")
        .defaultTo(0);

      table.string("status")
        .defaultTo("completed");

      table.timestamps(true, true);

    });

  await knex.schema
    .withSchema("app_test")
    .createTable("ocr_transactions", (table) => {

      table.increments("id").primary();

      table.uuid("document_id")
        .notNullable();

      table.date("transaction_date");

      table.date("value_date");

      table.text("narration");

      table.decimal("withdrawal", 18, 2);

      table.decimal("deposit", 18, 2);

      table.decimal("balance", 18, 2);

      table.string("merchant_name");

      table.string("group_key");

      table.timestamps(true, true);

      table
        .foreign("document_id")
        .references("document_id")
        .inTable("app_test.ocr_documents")
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("ocr_transactions");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("ocr_documents");

}