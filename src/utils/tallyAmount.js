// Tally amounts: signed, negative = Dr, positive = Cr (see the note in api/sync.routes.js).
export const parseTallyAmount = (value) => {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object") value = value["#text"] ?? value._ ?? "";
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const str = String(value).replace(/,/g, "").trim();
  const numbers = str.match(/\d+(?:\.\d+)?/g);
  if (!numbers?.length) return 0;
  const magnitude = Number(numbers[numbers.length - 1]);

  // An explicit Dr/Cr wins; otherwise a leading minus (currency symbols
  // may sit between it and the digits) or a minus right before the
  // last figure means Dr.
  let negative;
  if (/\bDr\b/i.test(str)) negative = true;
  else if (/\bCr\b/i.test(str)) negative = false;
  else negative = /^-/.test(str) || /-[^\d-]*\d+(?:\.\d+)?\s*$/.test(str);
  return negative ? -magnitude : magnitude;
};
