export async function up(knex) {
    await knex.schema
        .withSchema("app_test")
        .table("connector_machines", (table) => {
            table.string("guid").nullable();
        });
}

export async function down(knex) {
    await knex.schema
        .withSchema("app_test")
        .table("connector_machines", (table) => {
            table.dropColumn("guid");
        });
}