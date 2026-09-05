/**
 * connector_jobs had no company_id column at all — jobs were only ever
 * scoped by user_id. That's fine for a user with a single connector
 * device, but the 5-company cap work explicitly assumes the same admin/
 * accountant can have several devices, one per company, under one
 * account. With no company_id to filter on, GET /api/connector/jobs'
 * claim query (WHERE user_id = $1 AND status = 'pending') let ANY of a
 * user's devices claim ANY of their pending jobs — a job meant for
 * Company A's connector could be silently claimed by the device actually
 * running Company B's Tally, and the intended device would just see an
 * empty poll forever. This column, plus scoping the claim query and
 * verifyConnectorApiKey by it, fixes that.
 *
 * Nullable: discovery jobs (job_type "companies") run before any company
 * is known yet, so they legitimately have no company_id — those stay
 * claimable by any of the user's devices.
 */
export function up(knex) {
  return knex.schema.withSchema("app_test").alterTable("connector_jobs", (table) => {
    table.integer("company_id").nullable()
      .references("id").inTable("app_test.companies").onDelete("CASCADE");
    table.index(["user_id", "company_id", "status"], "connector_jobs_user_company_status_idx");
  });
}

export function down(knex) {
  return knex.schema.withSchema("app_test").alterTable("connector_jobs", (table) => {
    table.dropIndex(["user_id", "company_id", "status"], "connector_jobs_user_company_status_idx");
    table.dropColumn("company_id");
  });
}