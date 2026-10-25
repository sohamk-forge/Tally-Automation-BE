// Safe ways to put caller-supplied values into the XML / TDL requests sent to Tally.
// Company, ledger and group names, invoice numbers and the fromDate / toDate query params all reach
// Tally's request XML, so each goes through one of these first.

// Characters XML 1.0 cannot carry at all (everything below 0x20 except tab, LF, CR).
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Text for an XML element or attribute value. Markup characters are escaped; illegal characters dropped. */
export const escapeXml = (value) =>
  String(value ?? "")
    .replace(ILLEGAL_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** A Tally date: exactly YYYYMMDD and a real calendar date. Throws otherwise. */
export const tallyDate = (value) => {
  const s = String(value ?? "");
  if (!/^\d{8}$/.test(s)) throw new Error(`Invalid Tally date: expected YYYYMMDD`);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Invalid Tally date: not a calendar date`);
  }
  return s;
};

/** A numeric id (e.g. a voucher MasterID) that is pasted into a TDL formula. Digits only; throws otherwise. */
export const tallyId = (value) => {
  const s = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : String(value ?? "");
  if (!/^\d+$/.test(s)) throw new Error("Invalid Tally id: digits only");
  return s;
};

/**
 * Text placed inside a TDL "double quoted string" in a formula (e.g. an invoice number). XML-escaping is not
 * enough there: Tally decodes the XML before TDL parses it, so a quote would close the string. Values holding
 * a quote or a control character are refused.
 */
export const tdlText = (value) => {
  const s = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  if (/["\u0000-\u0008\u000a-\u001f]/.test(s)) throw new Error("Invalid value for a Tally formula");
  return escapeXml(s);
};
