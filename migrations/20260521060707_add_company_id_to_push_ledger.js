export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(

      "push_ledger",

      (table) => {

        table.bigInteger("company_id");

      }

    );

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .alterTable(

      "push_ledger",

      (table) => {

        table.dropColumn("company_id");

      }

    );

}