import { DB_SCHEMA } from "../src/config/db.js";
  export async function up(knex) {

    await knex.schema
      .withSchema(DB_SCHEMA)
      .alterTable(
        "invoice_extractions",
        (table) => {

          table.string("godown_name");

        }
      );

  }

  export async function down(knex) {

    await knex.schema
      .withSchema(DB_SCHEMA)
      .alterTable(
        "invoice_extractions",
        (table) => {

          table.dropColumn("godown_name");

        }
      );

  }