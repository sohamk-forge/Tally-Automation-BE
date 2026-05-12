export async function up(
  knex
) {

  await knex.schema
    .withSchema("app")
    .createTable(

      "parent_groups",

      (table) => {

        table.increments(
          "id"
        );

        table.string(
          "company_name"
        );

        table.string(
          "group_name"
        );

        table.timestamps(
          true,
          true
        );

      }

    );

}

export async function down(
  knex
) {

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "parent_groups"
    );

}