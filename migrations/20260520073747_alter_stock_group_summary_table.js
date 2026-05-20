export async function up(knex) {

  /* =====================================
     CREATE TABLE
  ===================================== */

  const exists = await knex.schema

    .withSchema("app")

    .hasTable(
      "stock_group_summary"
    );

  if (!exists) {

    await knex.schema

      .withSchema("app")

      .createTable(

        "stock_group_summary",

        (table) => {

          table.bigIncrements("id");

          table.bigInteger(
            "company_id"
          );

          table.text(
            "company_name"
          ).notNullable();

          table.text(
            "group_name"
          );

          table.text(
            "item_name"
          );

          table.decimal(
            "quantity",
            18,
            2
          ).defaultTo(0);

          table.decimal(
            "stock_value",
            18,
            2
          ).defaultTo(0);

          table.timestamp(
            "created_at"
          ).defaultTo(
            knex.fn.now()
          );

          table.timestamp(
            "updated_at"
          ).defaultTo(
            knex.fn.now()
          );

        }

      );

  }

}

/* =====================================
   DOWN
===================================== */

export async function down(knex) {

  await knex.schema

    .withSchema("app")

    .dropTableIfExists(

      "stock_group_summary"

    );

}