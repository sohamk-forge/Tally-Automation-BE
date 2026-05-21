export async function up(knex) {

  await knex.schema

    .withSchema("app")

    .table(

      "vouchers",

      (table) => {

        table.text(
          "parent_group"
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema("app")

    .table(

      "vouchers",

      (table) => {

        table.dropColumn(
          "parent_group"
        );

      }

    );

}