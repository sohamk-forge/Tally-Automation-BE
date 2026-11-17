// =========================================
// src/services/bulkLedgerSync.service.js
//
// Batched write phase of /api/sync/all-ledgers-sync.
//
// The route used to run 4-6 queries PER LEDGER, one after another, inside one
// transaction. The database is remote (~60 ms per round trip), so a company
// with 18,000 ledgers needed ~90,000 round trips (well over an hour) and
// outlived the sync worker's step timeout.
//
// This makes exactly the same decisions, in the same order, as that loop
// (adoptPushedLedgerRow -> upsertRecord's matching + alter_id gating ->
// balance refresh when the master update is skipped -> primary_group), but
// against ONE preloaded snapshot of the company's ledger rows, and then writes
// the result in a few batched statements. Same rules, same data, far fewer
// round trips. The old row-by-row loop is still in the route, used when
// SYNC_LEGACY_ROW_WRITES=true.
//
// Everything runs on the caller's client, inside the caller's transaction.
// =========================================

import { PUSHED_LEDGER_GUID_PREFIX } from "./masterUpsert.service.js";

const TABLE = "app_test.all_ledger_details";
const CHUNK = 1000;

// The 20 data columns the route builds (same names and order as its `columns`
// array) + the identity columns + primary_group. A fixed list, so every INSERT
// chunk has the same shape no matter which rows carry a primary_group.
const DATA_COLUMNS = [
  "company_id", "company_name", "ledger_name", "parent_group", "address", "state", "country", "pincode",
  "pan_number", "gst_number", "gst_registration_type", "contact_name", "phone_number",
  "primary_phone_number", "fax_no", "email", "opening_balance", "closing_balance",
  "opening_balance_type", "closing_balance_type"
];
const INSERT_COLUMNS = [...DATA_COLUMNS, "guid", "master_id", "alter_id", "primary_group"];

// Same normalisation as the SQL expression
// regexp_replace(LOWER(TRIM(ledger_name)), '\s+', ' ', 'g') used by adoptPushedLedgerRow.
const normName = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// `a IS NOT DISTINCT FROM b` for numeric values coming from pg (strings) or JS (numbers).
const sameNum = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Number(a) === Number(b);
};

const pushTo = (map, key, row) => {
  if (key == null) return;
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
};
const dropFrom = (map, key, row) => {
  const list = map.get(key);
  if (!list) return;
  const i = list.indexOf(row);
  if (i >= 0) list.splice(i, 1);
};

/**
 * @param client   pg client already inside BEGIN
 * @param companyId
 * @param records  one per Tally ledger, parsed by the route (no DB access needed to build them):
 *   { ledgerName, originalGuid, guid, masterId, alterId, parentGroup,
 *     openingBalance, closingBalance, openingBalanceType, closingBalanceType,
 *     data: { <DATA_COLUMNS>: value } }
 * @param groupHierarchy  Map, or null (then primary_group is left untouched, as before)
 * @param deps     { REAL_TALLY_GUID_PATTERN, tallyCompanyGuidPrefix, resolvePrimaryGroup }
 * @returns { counts: { inserted, updated, ignored, primaryGroupUpdated }, insertedLedgers, updatedLedgers }
 */
export async function bulkSyncLedgers(client, companyId, records, groupHierarchy, deps) {
  const { REAL_TALLY_GUID_PATTERN, tallyCompanyGuidPrefix, resolvePrimaryGroup } = deps;
  const startedAt = Date.now();

  // ---- 1. ONE read: every row this company has (soft-deleted included, like the old lookups) ----
  const { rows } = await client.query(
    `SELECT id, guid, master_id, alter_id, ledger_name, primary_group,
            opening_balance, closing_balance, opening_balance_type, closing_balance_type
       FROM ${TABLE}
      WHERE company_id = $1
      ORDER BY id`,
    [companyId]
  );

  const byGuid = new Map();       // guid          -> [row]
  const byMaster = new Map();     // String(mid)   -> [row]
  const byName = new Map();       // ledger_name   -> [row]   (exact, like WHERE ledger_name = $)
  const pushedByNorm = new Map(); // normalised    -> [row]   (placeholder rows written by app pushes)

  const index = (r) => {
    pushTo(byGuid, r.guid, r);
    if (r.master_id != null) pushTo(byMaster, String(r.master_id), r);
    pushTo(byName, r.ledger_name, r);
    if (typeof r.guid === "string" && r.guid.startsWith(PUSHED_LEDGER_GUID_PREFIX)) {
      pushTo(pushedByNorm, normName(r.ledger_name), r);
    }
  };
  for (const r of rows) {
    r.isNew = false;
    r.patch = null; // columns that must be written to this existing row
    index(r);
  }

  const touch = (row, cols) => {
    row.patch = Object.assign(row.patch || {}, cols);
  };
  const newRows = []; // rows to INSERT; also indexed, so a repeated ledger in one list sees them

  let inserted = 0, updated = 0, ignored = 0, primaryGroupUpdated = 0;
  const insertedLedgers = [];
  const updatedLedgers = [];

  // ---- 2. decide in memory, in the same order as the old loop ----
  for (const rec of records) {
    const { ledgerName, guid, masterId, alterId, parentGroup } = rec;
    const realGuid = Boolean(rec.originalGuid) && REAL_TALLY_GUID_PATTERN.test(guid);

    // 2a. adoptPushedLedgerRow: the lowest-id placeholder row with this normalised name takes the
    //     real GUID / master id, unless a row already owns that guid or master id.
    if (realGuid) {
      const cand = (pushedByNorm.get(normName(ledgerName)) || [])[0];
      const owned =
        (byGuid.get(guid) || []).length > 0 ||
        (masterId && (byMaster.get(String(masterId)) || []).length > 0);
      if (cand && !owned) {
        dropFrom(pushedByNorm, normName(ledgerName), cand);
        dropFrom(byGuid, cand.guid, cand);
        if (cand.master_id != null) dropFrom(byMaster, String(cand.master_id), cand);
        cand.guid = guid;
        cand.master_id = masterId ? String(masterId) : null;
        cand.alter_id = 0;
        pushTo(byGuid, cand.guid, cand);
        if (cand.master_id != null) pushTo(byMaster, cand.master_id, cand);
        touch(cand, { guid: cand.guid, master_id: cand.master_id, alter_id: 0 });
      }
    }

    // 2b. upsertRecord lookup: by master id (skipping rows of another Tally company), else by guid.
    let existing = null;
    if (masterId) {
      const incomingPrefix = tallyCompanyGuidPrefix(guid);
      existing =
        (byMaster.get(String(masterId)) || []).find((r) => {
          if (!incomingPrefix) return true;
          const rowPrefix = tallyCompanyGuidPrefix(r.guid);
          return !rowPrefix || rowPrefix === incomingPrefix;
        }) || null;
    }
    if (!existing) existing = (byGuid.get(guid) || [])[0] || null;

    let action;
    if (!existing) {
      const row = {
        id: null,
        isNew: true,
        patch: null,
        guid,
        master_id: masterId ? String(masterId) : null,
        alter_id: Number(alterId || 0),
        ledger_name: ledgerName,
        primary_group: null,
        opening_balance: rec.openingBalance,
        closing_balance: rec.closingBalance,
        opening_balance_type: rec.openingBalanceType,
        closing_balance_type: rec.closingBalanceType,
        insertData: { ...rec.data }
      };
      newRows.push(row);
      index(row);
      action = "inserted";
    } else {
      const dbAlterId = Number(existing.alter_id || 0);
      const newAlterId = Number(alterId || 0);
      const isSameMaster = String(masterId || "") === String(existing.master_id || "");
      const guidChanged = existing.guid !== guid;

      const skip = isSameMaster && guidChanged ? newAlterId < dbAlterId : newAlterId <= dbAlterId;

      if (skip) {
        action = "ignored";
      } else {
        // Full master update: all data columns + guid / master_id / alter_id.
        dropFrom(byGuid, existing.guid, existing);
        if (existing.master_id != null) dropFrom(byMaster, String(existing.master_id), existing);
        dropFrom(byName, existing.ledger_name, existing);
        const cols = { ...rec.data, guid, master_id: masterId || null, alter_id: newAlterId };
        if (existing.isNew) Object.assign(existing.insertData, cols);
        else touch(existing, cols);
        existing.guid = guid;
        existing.master_id = masterId ? String(masterId) : null;
        existing.alter_id = newAlterId;
        existing.ledger_name = ledgerName;
        existing.opening_balance = rec.openingBalance;
        existing.closing_balance = rec.closingBalance;
        existing.opening_balance_type = rec.openingBalanceType;
        existing.closing_balance_type = rec.closingBalanceType;
        pushTo(byGuid, existing.guid, existing);
        if (existing.master_id != null) pushTo(byMaster, existing.master_id, existing);
        pushTo(byName, existing.ledger_name, existing);
        action = "updated";
      }
    }

    // 2c. Balances are a point-in-time snapshot: when the master update was skipped, still write the
    //     latest balances to every row with this name whose values differ.
    if (action === "ignored") {
      for (const r of byName.get(ledgerName) || []) {
        if (
          !sameNum(r.opening_balance, rec.openingBalance) ||
          !sameNum(r.closing_balance, rec.closingBalance) ||
          (r.opening_balance_type ?? null) !== (rec.openingBalanceType ?? null) ||
          (r.closing_balance_type ?? null) !== (rec.closingBalanceType ?? null)
        ) {
          const cols = {
            opening_balance: rec.openingBalance,
            closing_balance: rec.closingBalance,
            opening_balance_type: rec.openingBalanceType,
            closing_balance_type: rec.closingBalanceType
          };
          if (r.isNew) Object.assign(r.insertData, cols);
          else touch(r, cols);
          Object.assign(r, cols);
        }
      }
    }

    // 2d. primary_group, written independently of alter_id (a group moved in Tally changes the
    //     group's alter_id, not the ledger's).
    if (groupHierarchy) {
      const primaryGroup = resolvePrimaryGroup(parentGroup, groupHierarchy);
      if (primaryGroup) {
        let changed = false;
        for (const r of byName.get(ledgerName) || []) {
          if ((r.primary_group ?? null) !== primaryGroup) {
            r.primary_group = primaryGroup;
            if (r.isNew) r.insertData.primary_group = primaryGroup;
            else touch(r, { primary_group: primaryGroup });
            changed = true;
          }
        }
        if (changed) primaryGroupUpdated++;
      }
    }

    if (action === "inserted") {
      inserted++;
      insertedLedgers.push({
        name: ledgerName,
        guid,
        parent_group: parentGroup,
        gst_number: rec.data.gst_number,
        has_address: !!rec.data.address,
        has_phone: !!(rec.data.phone_number || rec.data.primary_phone_number)
      });
    } else if (action === "updated") {
      updated++;
      updatedLedgers.push({ name: ledgerName, guid, parent_group: parentGroup });
    } else {
      ignored++;
    }
  }

  const decidedAt = Date.now();

  // ---- 3. write in batches. jsonb_populate_recordset types every value by the table's own columns. ----
  // 3a. inserts (fixed column list; absent keys become NULL, as the old INSERT left them unset)
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const chunk = newRows.slice(i, i + CHUNK).map((r) => {
      const obj = { ...r.insertData, guid: r.guid, master_id: r.master_id, alter_id: r.alter_id };
      if (obj.primary_group === undefined) obj.primary_group = null;
      return obj;
    });
    await client.query(
      `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(", ")}, created_at, updated_at)
       SELECT ${INSERT_COLUMNS.join(", ")}, NOW(), NOW()
         FROM jsonb_populate_recordset(NULL::${TABLE}, $1::jsonb)`,
      [JSON.stringify(chunk)]
    );
  }

  // 3b. updates: group the changed rows by which columns change (a handful of shapes), one UPDATE per chunk
  const shapes = new Map(); // "colA,colB" -> [{ id, ...patch }]
  for (const r of rows) {
    if (!r.patch) continue;
    const key = Object.keys(r.patch).sort().join(",");
    const list = shapes.get(key);
    const item = { id: r.id, ...r.patch };
    if (list) list.push(item);
    else shapes.set(key, [item]);
  }
  for (const [key, list] of shapes) {
    const cols = key.split(",");
    const set = cols.map((c) => `${c} = x.${c}`);
    // The old primary_group-only UPDATE did not touch updated_at; every other write did.
    if (cols.some((c) => c !== "primary_group")) set.push("updated_at = NOW()");
    for (let i = 0; i < list.length; i += CHUNK) {
      await client.query(
        `UPDATE ${TABLE} t
            SET ${set.join(", ")}
           FROM jsonb_populate_recordset(NULL::${TABLE}, $1::jsonb) x
          WHERE t.id = x.id AND t.company_id = $2`,
        [JSON.stringify(list.slice(i, i + CHUNK)), companyId]
      );
    }
  }

  console.log(
    `[ledger-sync] batched: ${records.length} ledgers, existing rows ${rows.length}, ` +
    `inserted ${inserted}, updated ${updated}, ignored ${ignored}, primary_group ${primaryGroupUpdated} ` +
    `(decide ${decidedAt - startedAt} ms, write ${Date.now() - decidedAt} ms)`
  );

  return {
    counts: { inserted, updated, ignored, primaryGroupUpdated },
    insertedLedgers,
    updatedLedgers
  };
}
