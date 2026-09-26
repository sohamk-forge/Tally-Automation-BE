export async function up(knex) {

  const exists =
    await knex.schema
      .withSchema("app")
      .hasTable(
        "profit_loss"
      );

  if (!exists) {

    await knex.schema
      .withSchema("app")
      .createTable(
        "profit_loss",
        (table) => {

          table.increments("id");

          table.string(
            "company_name"
          );

          table.string(
            "from_date"
          );

          table.string(
            "to_date"
          );

          table.decimal(
            "total_sales",
            18,
            2
          );

          table.decimal(
            "total_purchase",
            18,
            2
          );

          table.decimal(
            "stock_value",
            18,
            2
          );

          table.decimal(
            "gross_profit",
            18,
            2
          );

          table.decimal(
            "net_profit",
            18,
            2
          );

          table.decimal(
            "profit_margin",
            18,
            2
          );

          table.timestamps(
            true,
            true
          );

        }
      );

  }

}

export async function down(knex) {

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "profit_loss"
    );

}