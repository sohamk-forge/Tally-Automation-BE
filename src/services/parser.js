import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser();

export function parseXML(xml) {
  return parser.parse(xml);
}
/**
 * Same as parseXML, but the given tags keep their exact text instead of
 * being turned into numbers — e.g. a supplier invoice number "0138261429470493"
 * would otherwise lose its leading zero.
 */
export function parseXMLKeepText(xml, textTags) {
  const keep = new Set(textTags);
  return new XMLParser({ tagValueProcessor: (name, val) => (keep.has(name) ? undefined : val) }).parse(xml);
}
