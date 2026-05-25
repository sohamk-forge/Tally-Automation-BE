export async function up(knex) {

  const exists =
    await knex.schema
      .withSchema("app_test")
      .hasColumn(
        "sales_items",
        "company_id"
      );

  if (!exists) {

    await knex.schema
      .withSchema("app_test")
      .table("sales_items", (table) => {

        table.integer("company_id")
          .unsigned()
          .references("id")
          .inTable("app_test.companies")
          .onDelete("CASCADE");

        table.index(
          ["company_id"],
          "idx_sales_items_company_id"
        );

      });

  }

}

export async function down(knex) {

  const exists =
    await knex.schema
      .withSchema("app_test")
      .hasColumn(
        "sales_items",
        "company_id"
      );

  if (exists) {

    await knex.schema
      .withSchema("app_test")
      .table("sales_items", (table) => {

        table.dropIndex(
          ["company_id"],
          "idx_sales_items_company_id"
        );

        table.dropColumn("company_id");

      });

  }

}