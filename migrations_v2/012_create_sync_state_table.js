import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("sync_state", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

      table.bigInteger("last_voucher_alter_id")
        .defaultTo(0);

      table.bigInteger("last_master_alter_id")
        .defaultTo(0);

      table.timestamp("last_synced_at");

      table.string("company_name");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("sync_state");

}