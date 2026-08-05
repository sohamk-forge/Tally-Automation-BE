import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("sales_items", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.text("description");

      table.decimal("actual_quantity", 18, 2)
        .defaultTo(0);

      table.decimal("billed_quantity", 18, 2)
        .defaultTo(0);

      table.string("billing");

      table.decimal("total_amount", 18, 2)
        .defaultTo(0);

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("sales_items");

}