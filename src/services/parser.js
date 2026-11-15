import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser();

// Tally puts a ledger's real name in an attribute — <LEDGER NAME="HDFC CA - 930">
// — and the default parser drops attributes. The sync code then fell through
// to MAILINGNAME (the print name, "HDFC Bank Ltd."), saving ledgers under a
// name Tally doesn't know, so every voucher using it was rejected with
// "Ledger ... does not exist!". Copy the attribute into a <NAME> child (the
// first thing every sync's name lookup tries after the attribute forms).
const LEDGER_OPEN_TAG = /<LEDGER\b([^>]*?)\sNAME="([^"]*)"([^>]*?)(\/?)>/g;

function exposeLedgerName(xml) {
  if (typeof xml !== "string" || !xml.includes("<LEDGER")) return xml;
  return xml.replace(LEDGER_OPEN_TAG, (match, before, name, after, selfClose) =>
    selfClose ? match : `<LEDGER${before}${after}><NAME>${name}</NAME>`
  );
}

export function parseXML(xml) {
  return parser.parse(exposeLedgerName(xml));
}
/**
 * Same as parseXML, but the given tags keep their exact text instead of
 * being turned into numbers — e.g. a supplier invoice number "0138261429470493"
 * would otherwise lose its leading zero.
 */
export function parseXMLKeepText(xml, textTags) {
  const keep = new Set(textTags);
  return new XMLParser({ tagValueProcessor: (name, val) => (keep.has(name) ? undefined : val) }).parse(exposeLedgerName(xml));
}
