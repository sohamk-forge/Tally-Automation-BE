/**
 * Create GST Reconciliation Results table
 */

export async function up(knex) {
  // Ensure schema exists
  await knex.raw(`
    CREATE SCHEMA IF NOT EXISTS app_test;
  `);

  // Create reconciliation_results table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS app_test.reconciliation_results (
      id SERIAL PRIMARY KEY,

      -- Record identification
      company_name VARCHAR(255) NOT NULL,
      source_type VARCHAR(30) NOT NULL DEFAULT 'purchase',

      gstin VARCHAR(20),
      party_name VARCHAR(255),
      invoice_no VARCHAR(100),
      invoice_date DATE,

      -- Reconciliation result
      match_status VARCHAR(30) NOT NULL,

      -- User review state
      review_status VARCHAR(20) NOT NULL DEFAULT 'unreviewed',

      -- Source-side values
      source_taxable_value NUMERIC(15,2) NOT NULL DEFAULT 0,
      source_cgst         NUMERIC(15,2) NOT NULL DEFAULT 0,
      source_sgst         NUMERIC(15,2) NOT NULL DEFAULT 0,
      source_igst         NUMERIC(15,2) NOT NULL DEFAULT 0,
      source_total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,

      -- Tally-side values
      tally_taxable_value NUMERIC(15,2) NOT NULL DEFAULT 0,
      tally_cgst          NUMERIC(15,2) NOT NULL DEFAULT 0,
      tally_sgst          NUMERIC(15,2) NOT NULL DEFAULT 0,
      tally_igst          NUMERIC(15,2) NOT NULL DEFAULT 0,
      tally_total_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,

      -- Differences
      taxable_difference NUMERIC(15,2) NOT NULL DEFAULT 0,
      cgst_difference    NUMERIC(15,2) NOT NULL DEFAULT 0,
      sgst_difference    NUMERIC(15,2) NOT NULL DEFAULT 0,
      igst_difference    NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_difference   NUMERIC(15,2) NOT NULL DEFAULT 0,

      -- Matching information
      matched_by VARCHAR(50),

      -- Review information
      reviewed_at TIMESTAMP,
      reviewed_by VARCHAR(100),

      -- Audit timestamps
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- Prevent duplicate reconciliation records
      CONSTRAINT uq_reconciliation_result
        UNIQUE (
          company_name,
          source_type,
          gstin,
          invoice_no,
          invoice_date
        )
    );
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recon_company
    ON app_test.reconciliation_results(company_name);
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recon_source_type
    ON app_test.reconciliation_results(source_type);
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recon_match_status
    ON app_test.reconciliation_results(match_status);
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recon_review_status
    ON app_test.reconciliation_results(review_status);
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recon_invoice_no
    ON app_test.reconciliation_results(invoice_no);
  `);

  // Review status validation
  await knex.raw(`
    ALTER TABLE app_test.reconciliation_results
    DROP CONSTRAINT IF EXISTS chk_recon_review_status;
  `);

  await knex.raw(`
    ALTER TABLE app_test.reconciliation_results
    ADD CONSTRAINT chk_recon_review_status
    CHECK (
      review_status IN (
        'unreviewed',
        'accepted',
        'pending'
      )
    );
  `);

  // Match status validation
  await knex.raw(`
    ALTER TABLE app_test.reconciliation_results
    DROP CONSTRAINT IF EXISTS chk_recon_match_status;
  `);

  await knex.raw(`
    ALTER TABLE app_test.reconciliation_results
    ADD CONSTRAINT chk_recon_match_status
    CHECK (
      match_status IN (
        'matched',
        'partially_matched',
        'mismatched',
        'only_in_tally',
        'only_in_gstr2b'
      )
    );
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS app_test.reconciliation_results;
  `);
}