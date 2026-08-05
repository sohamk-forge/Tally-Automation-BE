import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("job_logs", (table) => {

      table.increments("id").primary();

      table.string("job_type");

      table.string("status");

      table.jsonb("payload");

      table.text("error_message");

      table.timestamp("created_at")
        .defaultTo(knex.fn.now());

      table.integer("user_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.users`)
        .onDelete("SET NULL");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("job_logs");

}