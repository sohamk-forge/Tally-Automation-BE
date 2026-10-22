/**
 * balanceRefresh.service.js
 * -------------------------
 * Moves the balance snapshots (app_test.all_ledger_details, group_balances) by the
 * effect of one posted voucher, so the Ledger list, Dashboard and receivable /
 * payable cards reflect a new invoice without waiting for the next full Tally sync.
 *
 * The effect is a per-ledger delta: sum(new ledger entries) - sum(old ledger entries).
 * "old" is what app_test.vouchers held for the same guid before the upsert (nothing
 * for a new voucher), so replays and edits never double count. Amounts use Tally's
 * sign (negative = Dr), the same sign all_ledger_details.closing_balance and
 * group_balances.closing_balance already carry. The next full sync overwrites both
 * tables from Tally, which corrects any drift.
 */
import { DB_SCHEMA } from "../config/db.js";

// group_balances rows the app keeps (see sync.routes.js /payable-debtors).
const TRACKED_GROUPS = ["sundry debtors", "sundry creditors", "sales accounts", "purchase accounts"];

const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const toNumber = (value) => {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

const keyOf = (name) => String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Per-ledger totals of a voucher's ledger entries, keyed by lower-cased ledger name. */
function totalsByLedger(entries) {
  const totals = new Map();
  for (const entry of toList(entries)) {
    const key = keyOf(entry?.LEDGERNAME);
    if (!key) continue;
    const current = totals.get(key) || { name: String(entry.LEDGERNAME).trim(), amount: 0 };
    current.amount += toNumber(entry?.AMOUNT);
    totals.set(key, current);
  }
  return totals;
}

/**
 * Applies (newEntries - oldEntries) to all_ledger_details and group_balances and
 * bumps the company's balances version. Run it in the same transaction as the
 * voucher upsert. Returns how many ledgers moved.
 */
export async function applyVoucherDelta(db, { companyId, oldEntries, newEntries }) {
  const before = totalsByLedger(oldEntries);
  const after = totalsByLedger(newEntries);

  const deltas = new Map();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(key)?.amount || 0) - (before.get(key)?.amount || 0);
    if (Math.abs(delta) >= 0.005) {
      deltas.set(key, { name: (after.get(key) || before.get(key)).name, delta });
    }
  }
  if (deltas.size === 0) return { ledgersUpdated: 0 };

  const groupDeltas = new Map();
  let ledgersUpdated = 0;

  for (const { name, delta } of deltas.values()) {
    const { rows } = await db.query(
      `
      UPDATE ${DB_SCHEMA}.all_ledger_details
      SET closing_balance = COALESCE(closing_balance, 0) + $3::numeric,
          closing_balance_type = CASE
            WHEN ABS(COALESCE(closing_balance, 0) + $3::numeric) < 0.005 THEN NULL
            WHEN COALESCE(closing_balance, 0) + $3::numeric < 0 THEN 'Dr'
            ELSE 'Cr'
          END,
          updated_at = NOW()
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND LOWER(TRIM(ledger_name)) = $2
      RETURNING primary_group, parent_group
      `,
      [companyId, keyOf(name), delta]
    );

    for (const row of rows) {
      ledgersUpdated++;
      const group = keyOf(row.primary_group || row.parent_group);
      if (TRACKED_GROUPS.includes(group)) {
        groupDeltas.set(group, (groupDeltas.get(group) || 0) + delta);
      }
    }
  }

  for (const [group, delta] of groupDeltas) {
    await db.query(
      `
      UPDATE ${DB_SCHEMA}.group_balances
      SET closing_balance = COALESCE(closing_balance, 0) + $3::numeric,
          updated_at = NOW()
      WHERE company_id = $1 AND LOWER(TRIM(group_name)) = $2
      `,
      [companyId, group, delta]
    );
  }

  return { ledgersUpdated };
}

/** Tells open pages (polling /balances-version) that balances changed. */
export async function bumpBalancesVersion(db, companyId) {
  await db.query(
    `
    INSERT INTO ${DB_SCHEMA}.company_balances_version (company_id, version, updated_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (company_id)
    DO UPDATE SET version = ${DB_SCHEMA}.company_balances_version.version + 1, updated_at = NOW()
    `,
    [companyId]
  );
}
