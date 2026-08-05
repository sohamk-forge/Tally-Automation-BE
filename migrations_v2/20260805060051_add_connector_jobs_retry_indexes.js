import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_jobs", (table) => {

      // Fast connector polling:
      // WHERE user_id = ? AND status = 'pending'
      table.index(
        ["user_id", "status"],
        "idx_connector_jobs_user_status"
      );

      // Fast stale processing-job lookup:
      // WHERE status = 'processing' AND claimed_at < ...
      table.index(
        ["status", "claimed_at"],
        "idx_connector_jobs_status_claimed_at"
      );

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_jobs", (table) => {

      table.dropIndex(
        ["user_id", "status"],
        "idx_connector_jobs_user_status"
      );

      table.dropIndex(
        ["status", "claimed_at"],
        "idx_connector_jobs_status_claimed_at"
      );

    });

}