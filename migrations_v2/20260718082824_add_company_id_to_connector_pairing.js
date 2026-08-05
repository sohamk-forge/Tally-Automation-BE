import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("connector_pairing_tokens", (table) => {

            // Add company_id column
            table.integer("company_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable(`${DB_SCHEMA}.companies`)
                .onDelete("CASCADE");

            // Add index for faster lookups
            table.index(["company_id"]);

            // Add index for user_id + company_id lookups
            table.index(["user_id", "company_id"]);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .table("connector_pairing_tokens", (table) => {

            // Drop the foreign key and column
            table.dropColumn("company_id");

        });

}