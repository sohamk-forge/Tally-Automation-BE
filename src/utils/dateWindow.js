// The date window a list page asks for (?from=YYYY-MM-DD&to=YYYY-MM-DD): the financial year picked in the
// company list at the top of the app. Without both dates there is no window and nothing is filtered.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isRealDay = (value) => {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

// -> { from, to } | null (no window asked for) | { error } (asked for, but not usable)
export function readDateWindow(query = {}) {
  const { from, to } = query;
  if (from === undefined && to === undefined) return null;
  if (!isRealDay(String(from)) || !isRealDay(String(to)) || String(from) > String(to)) {
    return { error: "from and to must be real YYYY-MM-DD dates, with from not after to" };
  }
  return { from: String(from), to: String(to) };
}

// "dd-mm-yyyy" (what the PDF statement service returns) -> "yyyy-mm-dd", or null when it is blank/unreadable.
export function dmyToIso(value) {
  const m = String(value ?? "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// A document covering startIso..endIso belongs to the window when the two ranges overlap.
export const overlapsWindow = (startIso, endIso, window) => startIso <= window.to && endIso >= window.from;

// Any date text an invoice may carry -> "yyyy-mm-dd", or null when it can't be read with confidence:
// 2026-09-12, 2026-09-12T10:00:00Z, 2026/09/12, 12-09-2026, 12/09/2026, 12.09.2026 (day first, as Indian invoices write it).
export function anyDateToIso(value) {
  const text = String(value ?? "").trim();
  let m = text.match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})(?:$|[T\s])/);
  if (m) return isRealDay(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = text.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return isRealDay(`${m[3]}-${m[2]}-${m[1]}`) ? `${m[3]}-${m[2]}-${m[1]}` : null;
  return null;
}

// Rows whose date falls inside the window. A row whose date can't be read stays in: hiding it would make an
// invoice vanish just because of how its date was typed.
export function filterRowsByWindow(rows, window, getDate) {
  if (!window) return rows;
  return rows.filter((row) => {
    const day = anyDateToIso(getDate(row));
    return !day || (day >= window.from && day <= window.to);
  });
}
