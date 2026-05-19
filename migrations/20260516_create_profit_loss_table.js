/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

export async function up(knex) {

  return knex.schema
    .withSchema("app")
    .createTable(

      "profit_loss",

      (table) => {

        table.bigIncrements("id")
          .primary();

        table.text(
          "company_name"
        );

        table.date(
          "from_date"
        );

        table.date(
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
          10,
          2
        );

        table.timestamp(
          "created_at"
        )
        .defaultTo(
          knex.fn.now()
        );

        table.timestamp(
          "updated_at"
        )
        .defaultTo(
          knex.fn.now()
        );

      }

    );

}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

export async function down(knex) {

  return knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "profit_loss"
    );

}