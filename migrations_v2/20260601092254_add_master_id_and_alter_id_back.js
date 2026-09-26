export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("ledgers", (table) => {

      table.bigInteger("master_id");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("ledgers", (table) => {

      table.dropColumn("master_id");

    });

}