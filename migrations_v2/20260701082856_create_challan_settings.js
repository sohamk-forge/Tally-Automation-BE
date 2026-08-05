import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("challan_settings", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .unsigned()
        .notNullable()
        .unique()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.string("prefix").notNullable();

      table.bigInteger("last_number").notNullable().defaultTo(0);

      table.integer("pad_length").notNullable().defaultTo(4);

      table.timestamps(true, true);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("challan_settings");
}