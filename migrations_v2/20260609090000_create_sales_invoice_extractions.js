import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema

    .withSchema(DB_SCHEMA)

    .createTable(

      "sales_invoice_extractions",

      (table) => {

        table
          .bigIncrements("id")
          .primary();

        table.text(
          "company_name"
        );

        table.text(
          "customer_name"
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

        table.integer(
          "company_id"
        )
        .unsigned();

        table.foreign(
          "company_id"
        )
        .references(
          "id"
        )
        .inTable(
          `${DB_SCHEMA}.companies`
        )
        .onDelete(
          "CASCADE"
        );

        table.text(
          "last_error"
        );

        table.integer(
          "error_count"
        ).defaultTo(0);

        table.timestamp(
          "processed_at",
          {
            useTz: true
          }
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

    .withSchema(DB_SCHEMA)

    .dropTableIfExists(
      "sales_invoice_extractions"
    );

}
