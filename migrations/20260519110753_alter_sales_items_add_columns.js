export async function up(knex) {

  return knex.schema.alterTable(

    "sales_items",

    (table) => {

      table.text(
        "voucher_number"
      );

      table.date(
        "voucher_date"
      );

    }

  );

}

export async function down(knex) {

  return knex.schema.alterTable(

    "sales_items",

    (table) => {

      table.dropColumn(
        "voucher_number"
      );

      table.dropColumn(
        "voucher_date"
      );

    }

  );

}