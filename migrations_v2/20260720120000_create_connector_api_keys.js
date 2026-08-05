import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("connector_api_keys", (table) => {

      table.increments("id").primary();

      table.bigInteger("user_id")
        .notNullable()
        .references("id")
        .inTable(`${DB_SCHEMA}.users`)
        .onDelete("CASCADE");

      table.string("machine_id").notNullable();

      table.string("key_hash").notNullable().unique();

      table.timestamp("created_at").defaultTo(knex.fn.now());

      table.timestamp("revoked_at").nullable();

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("connector_api_keys");

}
