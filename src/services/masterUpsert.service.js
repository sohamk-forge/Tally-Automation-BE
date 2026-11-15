// Writes a master (ledger / stock item) that was just created in Tally through
// a push into the synced tables the app reads from (all_ledger_details,
// stock_group_summary). Without this the new master only existed in
// push_ledger / push_stock_item, so screens built on the synced tables kept
// listing it as missing until the user ran a full sync.
//
// Both functions run on the caller's transaction client and are idempotent:
// a row that already exists is left alone (only un-deleted), so a later real
// sync stays the source of truth. Ledger rows are inserted with a non-Tally
// GUID and no master_id; the ledger sync adopts them by name (see
// adoptPushedLedgerRow) instead of inserting a duplicate.

const normalizeName = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();

// Marker prefix for rows written here. Real Tally GUIDs never start with it.
export const PUSHED_LEDGER_GUID_PREFIX = "pushed_ledger_";

const NORMALIZED_LEDGER_NAME = "regexp_replace(LOWER(TRIM(ledger_name)), '\\s+', ' ', 'g')";
const NORMALIZED_ITEM_NAME = "regexp_replace(LOWER(TRIM(item_name)), '\\s+', ' ', 'g')";

export async function upsertLedgerFromPush(client, pushLedgerId) {
  const { rows } = await client.query(
    `SELECT * FROM app_test.push_ledger WHERE id = $1`,
    [pushLedgerId]
  );
  const ledger = rows[0];
  if (!ledger || !ledger.company_id || !String(ledger.ledger_name || "").trim()) {
    return { action: "skipped" };
  }

  const name = String(ledger.ledger_name).trim();
  const normalized = normalizeName(name);

  const existing = await client.query(
    `SELECT id FROM app_test.all_ledger_details
      WHERE company_id = $1 AND ${NORMALIZED_LEDGER_NAME} = $2
      ORDER BY (deleted_at IS NOT NULL), id
      LIMIT 1`,
    [ledger.company_id, normalized]
  );

  if (existing.rows.length > 0) {
    // Already synced (or pushed earlier): keep its data, just make sure it is
    // not hidden by a soft delete from a time the ledger did not exist.
    await client.query(
      `UPDATE app_test.all_ledger_details
          SET deleted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [existing.rows[0].id]
    );
    return { action: "exists" };
  }

  const guid = `${PUSHED_LEDGER_GUID_PREFIX}${ledger.company_id}_${normalized.replace(/[^a-z0-9]+/g, "_")}`.slice(0, 250);

  // Balances are left at 0 on purpose: the sign convention of the pushed
  // opening balance differs from Tally's, and the next sync writes the real
  // figures.
  await client.query(
    `INSERT INTO app_test.all_ledger_details
       (guid, master_id, alter_id, company_id, company_name, ledger_name, parent_group,
        address, state, country, pincode, pan_number, gst_number, gst_registration_type,
        contact_name, phone_number, primary_phone_number, email,
        opening_balance, closing_balance, created_at, updated_at)
     VALUES ($1, NULL, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, 0, NOW(), NOW())`,
    [
      guid, ledger.company_id, ledger.company_name, name, ledger.parent_name || null,
      ledger.address || null, ledger.state || null, ledger.country || null, ledger.pincode || null,
      ledger.pan || null, ledger.gstin || null, ledger.gst_registration_type || null,
      ledger.contact_person || null, ledger.phone || null, ledger.mobile || null, ledger.email || null
    ]
  );
  return { action: "inserted" };
}

export async function upsertStockItemFromPush(client, pushStockItemId) {
  const { rows } = await client.query(
    `SELECT * FROM app_test.push_stock_item WHERE id = $1`,
    [pushStockItemId]
  );
  const item = rows[0];
  if (!item || !item.company_id || !String(item.item_name || "").trim()) {
    return { action: "skipped" };
  }

  const name = String(item.item_name).trim();
  const normalized = normalizeName(name);

  const existing = await client.query(
    `SELECT id FROM app_test.stock_group_summary
      WHERE company_id = $1 AND ${NORMALIZED_ITEM_NAME} = $2
      ORDER BY (deleted_at IS NOT NULL), id
      LIMIT 1`,
    [item.company_id, normalized]
  );

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE app_test.stock_group_summary
          SET deleted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [existing.rows[0].id]
    );
    return { action: "exists" };
  }

  const cgst = Number(item.cgst_rate) || 0;
  const sgst = Number(item.sgst_rate) || 0;
  const igst = Number(item.igst_rate) || 0;

  await client.query(
    `INSERT INTO app_test.stock_group_summary
       (company_id, company_name, group_name, item_name, hsn_code, quantity, stock_value,
        unit, gst_rate, cgst_rate, sgst_rate, igst_rate, gst_applicable)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      item.company_id, item.company_name, item.parent_group || null, name, item.hsn_code || null,
      Number(item.opening_quantity) || 0, Number(item.opening_value) || 0,
      item.unit_name || null, igst, cgst, sgst, igst, item.gst_applicable || null
    ]
  );
  return { action: "inserted" };
}

// Called by the all-ledgers sync before it upserts a real Tally ledger: if the
// only row for this name is one written by upsertLedgerFromPush, give it the
// real GUID/master id so the normal upsert updates it in place instead of
// inserting a second copy next to it.
export async function adoptPushedLedgerRow(client, companyId, ledgerName, realGuid, masterId) {
  if (!companyId || !ledgerName || !realGuid) return false;

  const result = await client.query(
    `UPDATE app_test.all_ledger_details
        SET guid = $3, master_id = $4, alter_id = 0, updated_at = NOW()
      WHERE id = (
        SELECT id FROM app_test.all_ledger_details
         WHERE company_id = $1
           AND ${NORMALIZED_LEDGER_NAME} = $2
           AND guid LIKE '${PUSHED_LEDGER_GUID_PREFIX}%'
         ORDER BY id
         LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_test.all_ledger_details
         WHERE company_id = $1 AND (guid = $3 OR ($4::text IS NOT NULL AND master_id::text = $4::text))
      )`,
    [companyId, normalizeName(ledgerName), realGuid, masterId ? String(masterId) : null]
  );
  return result.rowCount > 0;
}
