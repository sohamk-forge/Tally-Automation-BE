import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("invites", (table) => {

      table.increments("id").primary();

      table.string("email").notNullable();

      table.integer("invited_by_user_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.users`)
        .onDelete("CASCADE");

      table.string("supertokens_user_id");

      table.integer("invitee_user_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.users`)
        .onDelete("CASCADE");

      // invited -> pending_approval -> approved (or revoked at any point)
      table.string("status").notNullable().defaultTo("invited");

      table.timestamps(true, true);

      table.index(["invited_by_user_id"]);
      table.index(["email"]);
    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("invites");

}
