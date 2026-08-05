import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("sales_items", (table) => {

      table.string("voucher_number");

      table.index(
        ["voucher_number"],
        "idx_sales_items_voucher"
      );

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .table("sales_items", (table) => {

      table.dropIndex(
        ["voucher_number"],
        "idx_sales_items_voucher"
      );

      table.dropColumn("voucher_number");

    });

}