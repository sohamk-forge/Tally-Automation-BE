import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable(
      "connector_pairing_tokens",
      (table) => {

        table.uuid("id")
          .primary();

        table.integer("user_id")
          .notNullable();

        table.string("token", 100)
          .notNullable()
          .unique();

        table.timestamp("expires_at")
          .notNullable();

        table.boolean("is_used")
          .defaultTo(false);

        table.string("machine_id", 100);

        table.timestamp("created_at")
          .defaultTo(knex.fn.now());

        // Foreign Key
        table.foreign("user_id")
          .references("id")
          .inTable(`${DB_SCHEMA}.users`)
          .onDelete("CASCADE");

      }
    );

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists(
      "connector_pairing_tokens"
    );

}