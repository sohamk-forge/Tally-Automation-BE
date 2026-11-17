// Remembers which date pieces of a sync step (e.g. the half-month voucher requests) finished, so a rerun after a
// failed sync only redoes what is missing, and so voucher counts per period can be checked afterwards
// (records = vouchers in Tally's XML, saved = inserted + updated).
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${schema}.sync_piece_progress (
      company_id   INTEGER      NOT NULL,
      step         TEXT         NOT NULL,
      from_date    DATE         NOT NULL,
      to_date      DATE         NOT NULL,
      status       TEXT         NOT NULL,
      records      INTEGER,
      saved        INTEGER,
      error        TEXT,
      completed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      job_log_id   INTEGER,
      PRIMARY KEY (company_id, step, from_date, to_date)
    )
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`DROP TABLE IF EXISTS ${schema}.sync_piece_progress`);
}
