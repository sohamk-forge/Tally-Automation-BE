export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("connector_pairing_tokens", (table) => {

            // Add company_id column
            table.integer("company_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("app_test.companies")
                .onDelete("CASCADE");

            // Add index for faster lookups
            table.index(["company_id"]);

            // Add index for user_id + company_id lookups
            table.index(["user_id", "company_id"]);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("connector_pairing_tokens", (table) => {

            // Drop the foreign key and column
            table.dropColumn("company_id");

        });

}