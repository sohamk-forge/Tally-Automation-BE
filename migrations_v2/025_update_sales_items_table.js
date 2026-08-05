import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  const exists =
    await knex.schema
      .withSchema(DB_SCHEMA)
      .hasColumn(
        "sales_items",
        "company_id"
      );

  if (!exists) {

    await knex.schema
      .withSchema(DB_SCHEMA)
      .table("sales_items", (table) => {

        table.integer("company_id")
          .unsigned()
          .references("id")
          .inTable(`${DB_SCHEMA}.companies`)
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
      .withSchema(DB_SCHEMA)
      .hasColumn(
        "sales_items",
        "company_id"
      );

  if (exists) {

    await knex.schema
      .withSchema(DB_SCHEMA)
      .table("sales_items", (table) => {

        table.dropIndex(
          ["company_id"],
          "idx_sales_items_company_id"
        );

        table.dropColumn("company_id");

      });

  }

}