export async function up(
  knex
) {

  await knex.schema
    .withSchema("app")
    .table(

      "parent_groups",

      (table) => {

        table.string(
          "parent_group"
        );

        table.string(
          "primary_group"
        );

        table.string(
          "is_revenue"
        );

        table.string(
          "is_deemed_positive"
        );

      }

    );

}

export async function down(
  knex
) {

  await knex.schema
    .withSchema("app")
    .table(

      "parent_groups",

      (table) => {

        table.dropColumn(
          "parent_group"
        );

        table.dropColumn(
          "primary_group"
        );

        table.dropColumn(
          "is_revenue"
        );

        table.dropColumn(
          "is_deemed_positive"
        );

      }

    );

}