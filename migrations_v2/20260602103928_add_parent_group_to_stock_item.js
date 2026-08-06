export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("push_stock_item", (table) => {

      table.string("parent_group");
      table.integer("error_count").defaultTo(0);
      table.text("last_error");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("push_stock_item", (table) => {

      table.dropColumn("parent_group");
      table.dropColumn("error_count");
      table.dropColumn("last_error");

    });

}