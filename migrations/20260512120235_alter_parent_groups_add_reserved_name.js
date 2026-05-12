export async function up(
  knex
) {

  await knex.schema
    .withSchema("app")
    .table(

      "parent_groups",

      (table) => {

        table.string(
          "reserved_name"
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
          "reserved_name"
        );

      }

    );

}