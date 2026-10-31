// src/services/gstr1/gstr1Validator.js
//
// Validates a built GSTR-1 payload against the GSTN retsave JSON schema
// (src/schemas/gstr1-save.whitebooks.schema.json — the request schema WhiteBooks
// publishes for PUT /gstr1/retsave). Errors come back as builder-style issues,
// pointing at the invoice number where the path allows it.

import { readFileSync } from "fs";
import Ajv from "ajv";

const schema = JSON.parse(readFileSync(new URL("../../schemas/gstr1-save.whitebooks.schema.json", import.meta.url), "utf8"));

// strict: false — the GSTN schema uses keywords/shapes Ajv's strict mode
// rejects; multipleOfPrecision avoids float noise on multipleOf: 0.01.
// Ajv checks |round(v / 0.01) - v / 0.01| against 1e-N. Above about ₹10 crore the
// double's own spacing at v / 0.01 (~1e-6 and growing) exceeds a 1e-6 limit, so
// a perfectly valid two-decimal amount (an invoice or an HSN row of a large
// taxpayer) was rejected. 1e-3 still rejects any value off the paisa grid
// (a third decimal puts the quotient at least 0.1 away).
const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 3 });
const validate = ajv.compile(schema);

/** "/b2b/0/inv/3/itms/0/itm_det/iamt" -> "B2B invoice INV-12 (item 1): iamt" */
function describePath(payload, path) {
  const parts = path.split("/").filter(Boolean);
  const [sec, i, sub, j] = parts;
  const section = (sec || "payload").toUpperCase();
  let doc = null;
  if (["b2b", "b2cl"].includes(sec) && sub === "inv") doc = payload[sec]?.[i]?.inv?.[j]?.inum;
  if (sec === "cdnr" && sub === "nt") doc = payload.cdnr?.[i]?.nt?.[j]?.nt_num;
  if (sec === "cdnur") doc = payload.cdnur?.[i]?.nt_num;
  const field = parts[parts.length - 1];
  return { section, doc, field, where: doc ? `${section} ${doc}` : `${section}${i !== undefined ? ` row ${Number(i) + 1}` : ""}` };
}

export function validateGstr1Payload(payload) {
  if (validate(payload)) return [];

  // anyOf branches produce one error per branch; keep the most specific
  // message per path and drop the generic "must match a schema in anyOf".
  const byPath = new Map();
  for (const e of validate.errors) {
    if (e.keyword === "anyOf" || e.keyword === "if") continue;
    const path = e.instancePath + (e.keyword === "required" ? `/${e.params.missingProperty}` : "");
    if (!byPath.has(path)) byPath.set(path, e);
  }
  if (!byPath.size && validate.errors.length) {
    const e = validate.errors[0];
    byPath.set(e.instancePath, e);
  }

  return [...byPath].slice(0, 50).map(([path, e]) => {
    const d = describePath(payload, path);
    const what = e.keyword === "required" ? `missing ${e.params.missingProperty}` : `${d.field} ${e.message}`;
    return {
      severity: "error",
      code: "SCHEMA",
      message: `${d.where}: ${what}`,
      voucherNumber: d.doc || undefined,
      section: d.section.toLowerCase(),
      path,
    };
  });
}
