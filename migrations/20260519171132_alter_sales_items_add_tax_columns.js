export async function up(knex) {

  return knex.schema.alterTable(

    "sales_items",

    (table) => {

      table.text(
        "end_customer_name"
      );

      table.decimal(
        "cgst",
        15,
        2
      );

      table.decimal(
        "sgst",
        15,
        2
      );

      table.decimal(
        "taxes",
        15,
        2
      );

    }

  );

}

export async function down(knex) {

  return knex.schema.alterTable(

    "sales_items",

    (table) => {

      table.dropColumn(
        "end_customer_name"
      );

      table.dropColumn(
        "cgst"
      );

      table.dropColumn(
        "sgst"
      );

      table.dropColumn(
        "taxes"
      );

    }

  );

}