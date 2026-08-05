// migrations/xxxxxx_add_user_id_to_contra_vouchers.js
import { DB_SCHEMA } from "../src/config/db.js";

export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      table.integer("user_id");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("user_id");
    });
}