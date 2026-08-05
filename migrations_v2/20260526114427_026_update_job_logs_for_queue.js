import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema

    .withSchema(DB_SCHEMA)

    .alterTable(

      "job_logs",

      (table) => {

        table.timestamp(
          "started_at"
        );

        table.timestamp(
          "completed_at"
        );

        table.string(
          "job_id"
        );

      }

    );

}

export async function down(knex) {

  await knex.schema

    .withSchema(DB_SCHEMA)

    .alterTable(

      "job_logs",

      (table) => {

        table.dropColumn(
          "started_at"
        );

        table.dropColumn(
          "completed_at"
        );

        table.dropColumn(
          "job_id"
        );

      }

    );

}