// Indian financial years run 1 April -> 31 March. A sync range that spans several of them is pulled one
// financial year at a time: the first piece starts on the real start date, the last ends on the real end
// date, and every piece in between is a whole year.

const pad = (n) => String(n).padStart(2, "0");
const compact = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// "2026-10-01" or "20261001" -> Date (UTC midnight), or null when it is not a real date.
export function parseDay(value) {
  const m = String(value ?? "").trim().match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return compact(d) === `${m[1]}${m[2]}${m[3]}` ? d : null;
}

// The label every screen shows for a financial year: 2026 -> "2026-27".
export const financialYearLabel = (startYear) => `${startYear}-${String(Number(startYear) + 1).slice(2)}`;

/**
 * Splits fromDate..toDate into financial-year pieces, oldest first.
 *   splitIntoFinancialYears("2026-10-01", "2028-03-31") ->
 *     [{ fromDate: "20261001", toDate: "20270331", startYear: 2026, label: "2026-27" },
 *      { fromDate: "20270401", toDate: "20280331", startYear: 2027, label: "2027-28" }]
 * Returns [] when a date is invalid or the start is after the end.
 */
export function splitIntoFinancialYears(fromDate, toDate) {
  const from = parseDay(fromDate);
  const to = parseDay(toDate);
  if (!from || !to || from > to) return [];

  const pieces = [];
  let cursor = from;
  while (cursor <= to) {
    const startYear = cursor.getUTCMonth() >= 3 ? cursor.getUTCFullYear() : cursor.getUTCFullYear() - 1;
    const fyEnd = new Date(Date.UTC(startYear + 1, 2, 31));
    const pieceEnd = fyEnd < to ? fyEnd : to;
    pieces.push({ fromDate: compact(cursor), toDate: compact(pieceEnd), startYear, label: financialYearLabel(startYear) });
    cursor = new Date(pieceEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return pieces;
}

/**
 * The range a sync covers. Connectors that send real dates (fromDate/toDate) get exactly that range.
 * Older connectors only send two plain years, which are read as whole financial years (1 Apr fromYear ->
 * 31 Mar toYear); a toYear that is not after fromYear still means one full financial year.
 */
export function resolveSyncRange({ fromDate, toDate, fromYear, toYear }) {
  if (parseDay(fromDate) && parseDay(toDate)) {
    const pieces = splitIntoFinancialYears(fromDate, toDate);
    if (pieces.length) return pieces;
  }
  const start = Number(fromYear);
  if (!Number.isInteger(start)) return [];
  const end = Math.max(Number(toYear) || start + 1, start + 1);
  return splitIntoFinancialYears(`${start}-04-01`, `${end}-03-31`);
}
