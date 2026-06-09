export async function up(knex) {

  await knex.schema

    .withSchema("app_test")

    .createTable(

      "invoice_extractions",

      (table) => {

        table
          .bigIncrements("id")
          .primary();

        table.text(
          "company_name"
        );

        table.text(
          "vendor_name"
        );

        table.text(
          "gstin"
        );

        table.text(
          "invoice_no"
        );

        table.text(
          "invoice_date"
        );

        table.jsonb(
          "raw_json"
        );

        table.text(
          "sync_status"
        )
        .defaultTo(
          "pending" 
        );

        table.text(
          "error_message"
        );

        table.text(
          "tally_response"
        );

        table.timestamp(
          "created_at"
        )
        .defaultTo(
          knex.fn.now()
        );

        table.timestamp(
          "updated_at"
        )
        .defaultTo(
          knex.fn.now()
        );

        table.timestamp(
          "synced_at"
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app_test")

    .dropTableIfExists(
      "invoice_extractions"
    );

}