// Read-only check: look up a voucher's number by its master ID (LASTVCHID).
// Nothing is written to Tally.
//
//   node scripts/test-voucher-number-readback.mjs "<Company Name>" <masterId> [tallyUrl]
//
// tallyUrl defaults to http://localhost:9000 (Tally must be running with
// that company open and the XML/HTTP server enabled).
import { getVoucherNumberByMasterIdXML } from "../src/services/xmlBuilder.js";

const [company, masterId, url = "http://localhost:9000"] = process.argv.slice(2);
if (!company || !masterId) {
  console.error('Usage: node scripts/test-voucher-number-readback.mjs "<Company>" <masterId> [tallyUrl]');
  process.exit(1);
}

const xml = getVoucherNumberByMasterIdXML(company, masterId);
const res = await fetch(url, { method: "POST", body: xml });
const text = await res.text();
console.log(text);

const number = text.match(/<VOUCHERNUMBER(?:\s[^>]*)?>([\s\S]*?)<\/VOUCHERNUMBER>/)?.[1]?.trim();
console.log("\nParsed voucher number:", number || "(not found)");
