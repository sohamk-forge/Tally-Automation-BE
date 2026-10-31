// src/services/gstDeadlines.js
//
// Due dates, late fee and interest for GSTR-1 / GSTR-3B, so the app can show
// "overdue by N days, about ₹X so far" before someone files. Standard
// deadlines only: holidays, notified extensions and the exact turnover slab
// are not known here, so the result is an estimate and is labelled as one.
//
//   GSTR-1   monthly 11th, quarterly (QRMP) 13th of the following month
//   GSTR-3B  monthly 20th (turnover over ₹5 Cr), otherwise 22nd (group 1
//            states) or 24th; quarterly (QRMP) is 22nd / 24th
//   Late fee ₹50 a day (₹20 nil), capped at ₹10,000 (₹500 nil) — the cap is
//            lower for small turnover, so the estimate never understates the cap
//   Interest 18% a year on the tax paid in cash, from the day after the due date

const DAY_MS = 86_400_000;
const LATE_FEE_PER_DAY = 50;
const LATE_FEE_PER_DAY_NIL = 20;
const LATE_FEE_CAP = 10_000;
const LATE_FEE_CAP_NIL = 500;
const INTEREST_RATE = 0.18;

// State codes whose quarterly GSTR-3B is due on the 22nd (the rest: 24th).
const GROUP_1_STATES = new Set(["22", "23", "24", "25", "26", "27", "29", "30", "31", "32", "33", "34", "35", "36", "37"]);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** UTC midnight of a date given as y/m(1-12)/d. */
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** retPeriod "MMYYYY" -> { month, year } or null */
function parseRetPeriod(retPeriod) {
  const m = /^(0[1-9]|1[0-2])(\d{4})$/.exec(String(retPeriod || ""));
  return m ? { month: Number(m[1]), year: Number(m[2]) } : null;
}

/** The day after the period ends, as { y, m } (month after the period's last month). */
function nextMonth({ month, year }) {
  return month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
}

export function dueDateFor({ form, retPeriod, frequency = "MONTHLY", gstin = "", turnoverOver5Cr = false }) {
  const p = parseRetPeriod(retPeriod);
  if (!p) return null;
  const { y, m } = nextMonth(p);
  const quarterly = frequency === "QUARTERLY";
  let day;
  if (form === "GSTR1") {
    day = quarterly ? 13 : 11;
  } else if (form === "GSTR3B") {
    if (!quarterly && turnoverOver5Cr) day = 20;
    else day = GROUP_1_STATES.has(String(gstin).slice(0, 2)) ? 22 : 24;
  } else {
    return null;
  }
  return toIso(utc(y, m, day));
}

/**
 * Estimate what lateness costs today.
 * @param {object} a
 * @param {"GSTR1"|"GSTR3B"} a.form
 * @param {string} a.retPeriod        MMYYYY
 * @param {"MONTHLY"|"QUARTERLY"} [a.frequency]
 * @param {string} [a.gstin]
 * @param {number} [a.cashLiability]  3B tax payable in cash (interest base)
 * @param {boolean} [a.isNil]
 * @param {Date|string} [a.asOf]      date to measure to (default now; the filing date once filed)
 */
export function lateness({ form, retPeriod, frequency, gstin, cashLiability = 0, isNil = false, turnoverOver5Cr = false, asOf = new Date() }) {
  const dueDate = dueDateFor({ form, retPeriod, frequency, gstin, turnoverOver5Cr });
  if (!dueDate) return null;
  const asOfDate = new Date(asOf);
  const today = utc(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1, asOfDate.getUTCDate());
  const daysLate = Math.max(0, Math.round((today - Date.parse(dueDate)) / DAY_MS));
  const perDay = isNil ? LATE_FEE_PER_DAY_NIL : LATE_FEE_PER_DAY;
  const cap = isNil ? LATE_FEE_CAP_NIL : LATE_FEE_CAP;
  const lateFee = Math.min(cap, daysLate * perDay);
  const interestPerDay = form === "GSTR3B" ? r2((Math.max(0, cashLiability) * INTEREST_RATE) / 365) : 0;
  return {
    form,
    dueDate,
    daysLate,
    overdue: daysLate > 0,
    daysToDue: daysLate > 0 ? 0 : Math.round((Date.parse(dueDate) - today) / DAY_MS),
    lateFee: r2(lateFee),
    interestPerDay,
    interestSoFar: r2(interestPerDay * daysLate),
    estimate: true,
    note: "Estimate on standard due dates; holidays, extensions and your turnover slab can change it.",
  };
}
