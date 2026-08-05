import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  await knex.schema.withSchema(DB_SCHEMA).alterTable("connector_machines", (table) => {
    table.unique(["user_id"], "unique_user_connector");
  });
}

export async function down(knex) {
  await knex.schema.withSchema(DB_SCHEMA).alterTable("connector_machines", (table) => {
    table.dropUnique(["user_id"], "unique_user_connector");
  });
}