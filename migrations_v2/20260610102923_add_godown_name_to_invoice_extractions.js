  export async function up(knex) {

    await knex.schema
      .withSchema("app_test")
      .alterTable(
        "invoice_extractions",
        (table) => {

          table.string("godown_name");

        }
      );

  }

  export async function down(knex) {

    await knex.schema
      .withSchema("app_test")
      .alterTable(
        "invoice_extractions",
        (table) => {

          table.dropColumn("godown_name");

        }
      );

  }