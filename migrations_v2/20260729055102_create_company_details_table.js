import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("company_details", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE")
        .unique();

      table.string("company_name");

      table.text("address");

      table.string("state");

      table.string("email");

      table.string("gstin");

      table.timestamp("last_synced_at");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("company_details");

}