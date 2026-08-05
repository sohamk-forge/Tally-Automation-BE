import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  // Keep the lowest id per (user_id, company_id) pair, drop the rest
  await knex.raw(`
    DELETE FROM ${DB_SCHEMA}.user_companies a
    USING ${DB_SCHEMA}.user_companies b
    WHERE a.user_id = b.user_id
      AND a.company_id = b.company_id
      AND a.id > b.id
  `);

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("user_companies", (table) => {
      table.unique(["user_id", "company_id"]);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("user_companies", (table) => {
      table.dropUnique(["user_id", "company_id"]);
    });
}
