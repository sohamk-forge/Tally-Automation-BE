export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("ocr_extractions", (table) => {

      table.increments("id").primary();

      table.string("document_id");

      table.date("transaction_date");

      table.date("value_date");

      table.text("narration");

      table.decimal("withdrawal", 18, 2)
        .defaultTo(0);

      table.decimal("deposit", 18, 2)
        .defaultTo(0);

      table.decimal("balance", 18, 2)
        .defaultTo(0);

      table.string("merchant_name");

      table.string("group_key");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("ocr_extractions");

}