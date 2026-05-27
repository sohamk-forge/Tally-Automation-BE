export async function up(knex) {

  return knex.schema.createTable(

    "app.sales_items",

    (table) => {

      table.bigIncrements("id");

      table.text(
        "company_name"
      );

      table.text(
        "description"
      );

      table.text(
        "actual_quantity"
      );

      table.text(
        "billed_quantity"
      );

      table.decimal(
        "billing",
        15,
        2
      );

      table.decimal(
        "total_amount",
        15,
        2
      );

      table.timestamps(
        true,
        true
      );

    }

  );

}

export async function down(knex) {

  return knex.schema.dropTableIfExists(
    "app.sales_items"
  );

}