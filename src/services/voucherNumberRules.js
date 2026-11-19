// Pure voucher-number rules (no database), shared by the numbering service and its tests.

export function parseNumber(str) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(str ?? "").trim());
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3], value: Number(m[2]) };
}

// Highest trailing number seen + 1, keeping the prefix/suffix/zero-padding of that highest voucher
// (e.g. "FR/0042" -> "FR/0043"). "1" when there is nothing to continue from.
export function nextAfter(numbers) {
  let best = null;
  for (const n of numbers) {
    const p = parseNumber(n);
    if (p && (!best || p.value > best.value)) best = p;
  }
  if (!best) return "1";
  const next = String(best.value + 1).padStart(best.digits.length, "0");
  return `${best.prefix}${next}${best.suffix}`;
}

// Which number does an invoice push use?
//   existing - the number this invoice was given on an earlier attempt (or "")
//   live     - numbers Tally has right now for the type, or null if Tally could not be asked
//   synced   - numbers from the last sync (used only when live is null)
//   assigned - numbers this app already handed to other invoices of the same type
// An earlier number is reused (a retry must not burn a new one), unless Tally now has that number,
// meaning someone used it in the meantime; then the next free one is taken.
export function pickInvoiceNumber({ existing = "", live = null, synced = [], assigned = [] }) {
  const prev = String(existing || "").trim();
  if (prev && !(live && live.includes(prev))) return { number: prev, reused: true };
  const number = nextAfter([...(live ?? synced), ...assigned]);
  return { number, reused: false };
}
