export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("connector_api_keys", (table) => {

            table.integer("company_id")
                .unsigned()
                .nullable()
                .references("id")
                .inTable("app_test.companies")
                .onDelete("CASCADE");

            table.index(["company_id"]);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("connector_api_keys", (table) => {

            table.dropColumn("company_id");

        });

}
