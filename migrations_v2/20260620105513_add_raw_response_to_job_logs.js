export async function up(knex) {
    await knex.schema
        .withSchema("app_test")
        .table("job_logs", (table) => {
            table.text("raw_response").nullable();
        });
}

export async function down(knex) {
    await knex.schema
        .withSchema("app_test")
        .table("job_logs", (table) => {
            table.dropColumn("raw_response");
        });
}