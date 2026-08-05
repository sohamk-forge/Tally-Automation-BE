import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .createTable("parent_groups", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.string("group_name");

      table.timestamps(true, true);

      table.string("primary_group");

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("CASCADE");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .dropTableIfExists("parent_groups");

}