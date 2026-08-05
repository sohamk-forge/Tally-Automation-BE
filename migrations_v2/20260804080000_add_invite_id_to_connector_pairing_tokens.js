import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_pairing_tokens", (table) => {

      table.integer("invite_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.invites`)
        .onDelete("CASCADE");

      table.index(["invite_id"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_pairing_tokens", (table) => {

      table.dropColumn("invite_id");

    });

}
