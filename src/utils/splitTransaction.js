// Rules for splitting one bank-statement row into several. Money is handled
// in paise (integers) so the parts can never drift from the original by 0.01.

export const MAX_SPLIT_PARTS = 50;
const MAX_NARRATION_LENGTH = 2000;

// "1234.5" / 1234.5 / "1,234.50" -> 123450. Anything else (negative, 3+
// decimals, text, NaN) -> null.
export function toPaise(value) {
  const s = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const paiseToAmount = (paise) => (paise / 100).toFixed(2);

// Returns { ok: true, parts: [{ paise, narration }] } or { ok: false, message }.
export function validateSplitParts(rawParts, originalAmount) {
  if (!Array.isArray(rawParts) || rawParts.length < 2) {
    return { ok: false, message: "A split needs at least 2 parts" };
  }
  if (rawParts.length > MAX_SPLIT_PARTS) {
    return { ok: false, message: `A split can have at most ${MAX_SPLIT_PARTS} parts` };
  }

  const parts = [];
  for (const [i, p] of rawParts.entries()) {
    const paise = toPaise(p?.amount);
    if (paise === null || paise <= 0) {
      return { ok: false, message: `Part ${i + 1} needs an amount greater than 0 (up to 2 decimals)` };
    }
    const narration = p?.narration == null ? "" : String(p.narration).trim();
    if (narration.length > MAX_NARRATION_LENGTH) {
      return { ok: false, message: `Part ${i + 1} narration is too long` };
    }
    parts.push({ paise, narration });
  }

  const originalPaise = toPaise(originalAmount);
  const total = parts.reduce((s, p) => s + p.paise, 0);
  if (originalPaise === null || total !== originalPaise) {
    return {
      ok: false,
      message: `Parts add up to ${paiseToAmount(total)} but the original is ${originalPaise === null ? "unknown" : paiseToAmount(originalPaise)}`,
    };
  }

  return { ok: true, parts };
}
