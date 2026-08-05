import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("stock_group_summary", (table) => {
      table.decimal("gst_rate", null)
        .notNullable()
        .defaultTo(0)
        .alter();

      table.decimal("rate", null)
        .notNullable()
        .defaultTo(0)
        .alter();
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("stock_group_summary", (table) => {
      table.decimal("gst_rate", 5, 2)
        .notNullable()
        .defaultTo(0)
        .alter();

      table.decimal("rate", 15, 2)
        .notNullable()
        .defaultTo(0)
        .alter();
    });
}