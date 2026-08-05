import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_details", (table) => {

      table.boolean("gst_enabled")
        .notNullable()
        .defaultTo(false);

      table.string("gst_registration_type");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_details", (table) => {

      table.dropColumn("gst_enabled");
      table.dropColumn("gst_registration_type");

    });

}