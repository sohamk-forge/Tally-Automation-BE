import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema

    .withSchema(DB_SCHEMA)

    .createTable(

      "contra_vouchers",

      (table) => {

        table
          .bigIncrements("id")
          .primary();

        table
          .bigInteger("company_id")
          .notNullable();

        table
          .foreign("company_id")
          .references("id")
          .inTable(`${DB_SCHEMA}.companies`)
          .onUpdate("CASCADE")
          .onDelete("CASCADE");

        table.string(
          "company_name"
        );

        table.string(
          "voucher_type"
        );

        table.string(
          "voucher_number"
        );

        table.date(
          "voucher_date"
        );

        table.string(
          "party_ledger"
        );

        table.string(
          "bank_ledger"
        );

        table.decimal(
          "amount",
          18,
          2
        );

        table.text(
          "narration"
        );

        table.string(
          "instrument_number"
        );

        table.string(
          "transfer_bank"
        );

        table.string(
          "status"
        )
        .defaultTo("PENDING");

        table.text(
          "tally_response"
        );

        table.timestamp(
          "created_at"
        )
        .defaultTo(
          knex.fn.now()
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema(DB_SCHEMA)

    .dropTableIfExists(
      "contra_vouchers"
    );

}