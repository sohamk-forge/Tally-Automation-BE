// ledger_embeddings, account_closing_balances and stock_group_summary were
// keyed on company_name. Several companies rows can share one name (one per
// user pairing), so those rows collided / leaked across same-named companies.
//
// Legacy rows are only attributed to a company_id when the name maps to
// exactly one companies row; ambiguous ones are left NULL (the code now
// ignores NULL-id embeddings / closing balances, and the stock sync adopts
// legacy stock_group_summary rows on its next run).

const BACKFILL_SOURCE = `
  SELECT lower(trim(name)) AS n, min(id) AS id
  FROM app_test.companies
  GROUP BY 1
  HAVING count(*) = 1
`;

export async function up(knex) {
  // ---- ledger_embeddings ----
  await knex.raw(`
    ALTER TABLE app_test.ledger_embeddings
    ADD COLUMN IF NOT EXISTS company_id INTEGER
      REFERENCES app_test.companies(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    UPDATE app_test.ledger_embeddings le
    SET company_id = u.id
    FROM (${BACKFILL_SOURCE}) u
    WHERE le.company_id IS NULL
      AND lower(trim(le.company_name)) = u.n
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ledger_embeddings_company_id_idx
    ON app_test.ledger_embeddings (company_id)
  `);

  // ---- account_closing_balances (a 60s cache of Tally balances) ----
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    ADD COLUMN IF NOT EXISTS company_id INTEGER
      REFERENCES app_test.companies(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    UPDATE app_test.account_closing_balances b
    SET company_id = u.id
    FROM (${BACKFILL_SOURCE}) u
    WHERE b.company_id IS NULL
      AND lower(trim(b.company_name)) = u.n
  `);
  // Cache rows that can't be attributed to one company are unusable; they refill from Tally.
  await knex.raw(`DELETE FROM app_test.account_closing_balances WHERE company_id IS NULL`);
  // Both the knex-generated and the hand-added name-keyed unique constraints.
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    DROP CONSTRAINT IF EXISTS account_closing_balances_company_name_balance_type_unique
  `);
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    DROP CONSTRAINT IF EXISTS acb_company_balance_unique
  `);
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    ALTER COLUMN company_id SET NOT NULL
  `);
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    ADD CONSTRAINT acb_company_id_balance_unique UNIQUE (company_id, balance_type)
  `);

  // ---- stock_group_summary: attribute legacy rows with no company_id ----
  await knex.raw(`
    UPDATE app_test.stock_group_summary s
    SET company_id = u.id
    FROM (${BACKFILL_SOURCE}) u
    WHERE s.company_id IS NULL
      AND lower(trim(s.company_name)) = u.n
  `);
}

// The name-keyed unique constraints are not restored: they cannot be
// re-added once same-named companies have separate rows.
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE app_test.account_closing_balances
    DROP CONSTRAINT IF EXISTS acb_company_id_balance_unique
  `);
  await knex.raw(`ALTER TABLE app_test.account_closing_balances DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`DROP INDEX IF EXISTS app_test.ledger_embeddings_company_id_idx`);
  await knex.raw(`ALTER TABLE app_test.ledger_embeddings DROP COLUMN IF EXISTS company_id`);
}
