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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Splits one piece (a { fromDate, toDate, label } range, YYYYMMDD strings) into calendar months, oldest
 * first: the first month starts on the piece's real start date and the last ends on its real end date.
 * Used to ask Tally for a big voucher range one month at a time, so no single export has to be built for
 * a whole year.
 *   splitIntoMonths({ fromDate: "20230401", toDate: "20240331", label: "2023-24" }) ->
 *     [{ fromDate: "20230401", toDate: "20230430", label: "2023-24 Apr" }, ... { ..."20240301", "20240331", "2023-24 Mar" }]
 * Returns [piece] unchanged when its dates are not valid.
 */
export function splitIntoMonths(piece) {
  const from = parseDay(piece?.fromDate);
  const to = parseDay(piece?.toDate);
  if (!from || !to || from > to) return [piece];

  const months = [];
  let cursor = from;
  while (cursor <= to) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const pieceEnd = monthEnd < to ? monthEnd : to;
    months.push({
      ...piece,
      fromDate: compact(cursor),
      toDate: compact(pieceEnd),
      label: `${piece.label} ${MONTH_NAMES[cursor.getUTCMonth()]}`
    });
    cursor = new Date(pieceEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return months;
}

/**
 * Like splitIntoMonths, but every month is cut in two: days 1-15 and 16-end (a piece that starts or ends
 * inside a half keeps its real start / end date). Used for vouchers: Tally returned corrupted XML for a
 * single month with ~1,600 vouchers (26 MB), so each request is kept to about half that.
 *   splitIntoHalfMonths({ fromDate: "20230701", toDate: "20230731", label: "2023-24" }) ->
 *     [{ fromDate: "20230701", toDate: "20230715", label: "2023-24 Jul 1-15" },
 *      { fromDate: "20230716", toDate: "20230731", label: "2023-24 Jul 16-31" }]
 */
export function splitIntoHalfMonths(piece) {
  return splitIntoMonths(piece).flatMap((month) => {
    const from = parseDay(month.fromDate);
    const to = parseDay(month.toDate);
    if (!from || !to) return [month];

    const mid = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 15));
    if (from > mid || to <= mid) {
      // the month piece lies entirely inside one half
      return [{ ...month, label: `${month.label} ${from.getUTCDate()}-${to.getUTCDate()}` }];
    }
    const secondStart = new Date(mid.getTime() + 24 * 60 * 60 * 1000);
    return [
      { ...month, toDate: compact(mid), label: `${month.label} ${from.getUTCDate()}-15` },
      { ...month, fromDate: compact(secondStart), label: `${month.label} 16-${to.getUTCDate()}` }
    ];
  });
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
