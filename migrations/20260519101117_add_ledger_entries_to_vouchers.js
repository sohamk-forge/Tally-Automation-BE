export async function up(knex) {

  return knex.schema.alterTable(

    "app.vouchers",

    (table) => {

      table.jsonb(
        "ledger_entries"
      );

    }

  );

}

export async function down(knex) {

  return knex.schema.alterTable(

    "app.vouchers",

    (table) => {

      table.dropColumn(
        "ledger_entries"
      );

    }

  );

}