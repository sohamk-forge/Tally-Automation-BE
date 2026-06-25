export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .table("ledgers", (table) => {

      table.bigInteger("alter_id");

    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .table("ledgers", (table) => {

      table.dropColumn("alter_id");

    });
}