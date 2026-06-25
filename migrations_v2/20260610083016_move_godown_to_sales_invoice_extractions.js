export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "sales_invoice_extractions",
      (table) => {

        table.string("godown_name");

      }
    );

  const hasTable =
    await knex.schema
      .withSchema("app_test")
      .hasTable(
        "company_sales_ledger_mappings"
      );

  if (hasTable) {

    const hasColumn =
      await knex.schema
        .withSchema("app_test")
        .hasColumn(
          "company_sales_ledger_mappings",
          "godown_name"
        );

    if (hasColumn) {

      await knex.schema
        .withSchema("app_test")
        .alterTable(
          "company_sales_ledger_mappings",
          (table) => {

            table.dropColumn(
              "godown_name"
            );

          }
        );

    }

  }

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "company_sales_ledger_mappings",
      (table) => {

        table
          .string("godown_name")
          .defaultTo(
            "Main Location"
          );

      }
    );

  await knex.schema
    .withSchema("app_test")
    .alterTable(
      "sales_invoice_extractions",
      (table) => {

        table.dropColumn(
          "godown_name"
        );

      }
    );

}