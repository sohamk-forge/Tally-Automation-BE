// GST fields from the Tally voucher header, needed for filing:
//   supplier_invoice_no / _date  REFERENCE / REFERENCEDATE — the supplier's own
//                                invoice number on purchases (IMS matching)
//   party_gstin, place_of_supply PARTYGSTIN / PLACEOFSUPPLY as on the voucher
//   is_cancelled, is_optional    ISCANCELLED / ISOPTIONAL — never filed
// Filled on the next voucher sync; older rows stay NULL until re-synced.
export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`
    ALTER TABLE ${schema}.vouchers
      ADD COLUMN IF NOT EXISTS supplier_invoice_no TEXT,
      ADD COLUMN IF NOT EXISTS supplier_invoice_date DATE,
      ADD COLUMN IF NOT EXISTS party_gstin VARCHAR(15),
      ADD COLUMN IF NOT EXISTS place_of_supply TEXT,
      ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN,
      ADD COLUMN IF NOT EXISTS is_optional BOOLEAN
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vouchers_party_gstin_invoice
    ON ${schema}.vouchers (company_id, party_gstin, supplier_invoice_no)
    WHERE supplier_invoice_no IS NOT NULL
  `);
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";
  await knex.raw(`DROP INDEX IF EXISTS ${schema}.idx_vouchers_party_gstin_invoice`);
  await knex.raw(`
    ALTER TABLE ${schema}.vouchers
      DROP COLUMN IF EXISTS supplier_invoice_no,
      DROP COLUMN IF EXISTS supplier_invoice_date,
      DROP COLUMN IF EXISTS party_gstin,
      DROP COLUMN IF EXISTS place_of_supply,
      DROP COLUMN IF EXISTS is_cancelled,
      DROP COLUMN IF EXISTS is_optional
  `);
}
