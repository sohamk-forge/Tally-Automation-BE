export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .table("sales_items", (table) => {

      table.integer("company_id");

      table.index(
        ["company_id"],
        "idx_sales_items_company_id"
      );

    });

}

export async function down(knex) {

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