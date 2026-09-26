import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser();

export function parseXML(xml) {
  return parser.parse(xml);
}