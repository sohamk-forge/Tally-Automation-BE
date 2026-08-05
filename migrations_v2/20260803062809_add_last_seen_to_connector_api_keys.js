import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_api_keys", (table) => {
      table.timestamp("last_seen_at").nullable();
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_api_keys", (table) => {
      table.dropColumn("last_seen_at");
    });
}