import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema.withSchema(DB_SCHEMA).alterTable("challans", (table) => {
    table.decimal("grand_total", 18, 2).defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.withSchema(DB_SCHEMA).alterTable("challans", (table) => {
    table.dropColumn("grand_total");
  });
}