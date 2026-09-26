export async function up(knex) {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS vector`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS app_test.statement_jobs (
      company_id  BIGINT      NOT NULL,
      file_name   TEXT        NOT NULL,
      status      TEXT        NOT NULL,
      error       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, file_name)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS app_test.group_key_embeddings (
      group_key  TEXT PRIMARY KEY,
      embedding  vector(384) NOT NULL
    )
  `);

  // Already exists in deployed databases (created outside migrations); this only fills the gap for fresh ones.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS app_test.ledger_embeddings (
      id            BIGSERIAL PRIMARY KEY,
      company_name  TEXT NOT NULL,
      group_key     TEXT NOT NULL,
      ledger_name   TEXT NOT NULL,
      embedding     vector(384) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ledger_embeddings_company_idx ON app_test.ledger_embeddings (company_name)`
  );
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS app_test.statement_jobs`);
  await knex.raw(`DROP TABLE IF EXISTS app_test.group_key_embeddings`);
}
