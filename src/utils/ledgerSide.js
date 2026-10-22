/**
 * Per-ledger view of a voucher, the way Tally's Ledger Vouchers report
 * shows it.
 *
 * vouchers.debit_amount / credit_amount are stored from the PARTY ledger's
 * side (sync.routes.js). That is wrong for any other ledger the voucher
 * touches — e.g. a Cash → Bank contra has party "Cash", so the bank's
 * statement would show Cash's credit instead of the bank's debit. Here the
 * amount is taken from the viewed ledger's own entries instead:
 *
 *   - every entry of the ledger is summed (a ledger can appear more than
 *     once in a voucher), and the net is shown — negative AMOUNT = Dr,
 *     positive = Cr, as in Tally's XML;
 *   - Particulars is the other ledger when there is exactly one, otherwise
 *     "(as per details)".
 */

export const normLedgerName = (name) =>
  String(name ?? "").trim().toLowerCase();

const toNumber = (value) => {
  const num = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
};

const round2 = (num) => Math.round(num * 100) / 100;

export function parseLedgerEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

/**
 * Returns { debit, credit, particulars } for `ledgerName` within a voucher,
 * or null when the ledger has no entry of its own (caller keeps the stored
 * party-side amounts).
 */
export function ledgerSideOf(ledgerEntries, ledgerName) {
  const target = normLedgerName(ledgerName);
  const entries = parseLedgerEntries(ledgerEntries);

  const own = entries.filter((e) => normLedgerName(e?.LEDGERNAME) === target);
  if (own.length === 0) return null;

  const net = round2(own.reduce((sum, e) => sum + toNumber(e?.AMOUNT), 0));

  const others = [];
  const seen = new Set();
  for (const e of entries) {
    const name = String(e?.LEDGERNAME ?? "").trim();
    const key = normLedgerName(name);
    if (!key || key === target || seen.has(key)) continue;
    seen.add(key);
    others.push(name);
  }

  return {
    debit: net < 0 ? Math.abs(net) : 0,
    credit: net > 0 ? net : 0,
    particulars: others.length === 1 ? others[0] : "(as per details)",
  };
}
