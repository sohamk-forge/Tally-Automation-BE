import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("bank_accounts", (table) => {

      table.decimal(
        "opening_balance",
        18,
        2
      );

      table.decimal(
        "closing_balance",
        18,
        2
      );

      table.string(
        "opening_balance_type"
      );

      table.string(
        "closing_balance_type"
      );

      table.string(
        "email"
      );

      table.string(
        "phone_number"
      );

      table.string(
        "primary_phone_number"
      );

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("bank_accounts", (table) => {

      table.dropColumn(
        "opening_balance"
      );

      table.dropColumn(
        "closing_balance"
      );

      table.dropColumn(
        "opening_balance_type"
      );

      table.dropColumn(
        "closing_balance_type"
      );

      table.dropColumn(
        "email"
      );

      table.dropColumn(
        "phone_number"
      );

      table.dropColumn(
        "primary_phone_number"
      );

    });

}