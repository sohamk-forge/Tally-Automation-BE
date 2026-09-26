export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .alterTable("connector_machines", (table) => {

            table.string("company_name");

            table.integer("from_year");

            table.integer("to_year");

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .alterTable("connector_machines", (table) => {

            table.dropColumn("company_name");

            table.dropColumn("from_year");

            table.dropColumn("to_year");

        });

}