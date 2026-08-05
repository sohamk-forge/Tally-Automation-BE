import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("users", (table) => {

      table.string("supertokens_user_id").unique();

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("users", (table) => {

      table.dropColumn("supertokens_user_id");

    });

}
