export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .alterTable("connector_machines", (table) => {

            table.string("connector_url");

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .alterTable("connector_machines", (table) => {

            table.dropColumn("connector_url");

        });

}