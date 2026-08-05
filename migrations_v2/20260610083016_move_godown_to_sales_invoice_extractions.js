import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable(
      "sales_invoice_extractions",
      (table) => {

        table.string("godown_name");

      }
    );

  const hasTable =
    await knex.schema
      .withSchema(DB_SCHEMA)
      .hasTable(
        "company_sales_ledger_mappings"
      );

  if (hasTable) {

    const hasColumn =
      await knex.schema
        .withSchema(DB_SCHEMA)
        .hasColumn(
          "company_sales_ledger_mappings",
          "godown_name"
        );

    if (hasColumn) {

      await knex.schema
        .withSchema(DB_SCHEMA)
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
    .withSchema(DB_SCHEMA)
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
    .withSchema(DB_SCHEMA)
    .alterTable(
      "sales_invoice_extractions",
      (table) => {

        table.dropColumn(
          "godown_name"
        );

      }
    );

}