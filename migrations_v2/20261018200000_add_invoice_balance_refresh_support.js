// Balance refresh after a posted invoice.
//   invoice_extractions.tally_master_id   LASTVCHID of the purchase voucher (sales already has it), so the
//                                         post-invoice job can read the voucher back from Tally
//   company_balances_version              bumped each time balances are adjusted; the frontend polls it and
//                                         refetches the Ledger / Dashboard / LedgerDetail pages
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.invoice_extractions
      ADD COLUMN IF NOT EXISTS tally_master_id TEXT
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${schema}.company_balances_version (
      company_id INTEGER PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`DROP TABLE IF EXISTS ${schema}.company_balances_version`);
  await knex.raw(`ALTER TABLE ${schema}.invoice_extractions DROP COLUMN IF EXISTS tally_master_id`);
}
