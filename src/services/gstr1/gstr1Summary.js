// src/services/gstr1/gstr1Summary.js
//
// Section totals of a GSTR-1 retsave payload in the shape of the portal's
// summary (GET /gstr1/retsum -> data.sec_sum), and the comparison between
// what we saved and what the portal reports.
//
// GSTN summary fields: ttl_rec (records), ttl_val (invoice value),
// ttl_tax (taxable value), ttl_igst / ttl_cgst / ttl_sgst / ttl_cess.

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const blank = (sec_nm) => ({ sec_nm, ttl_rec: 0, ttl_val: 0, ttl_tax: 0, ttl_igst: 0, ttl_cgst: 0, ttl_sgst: 0, ttl_cess: 0 });

function addItems(t, itms) {
  for (const { itm_det: d } of itms || []) {
    t.ttl_tax += num(d.txval);
    t.ttl_igst += num(d.iamt);
    t.ttl_cgst += num(d.camt);
    t.ttl_sgst += num(d.samt);
    t.ttl_cess += num(d.csamt);
  }
}

const finish = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v]));

/** payload -> [{ sec_nm, ttl_rec, ttl_val, ttl_tax, ttl_igst, ttl_cgst, ttl_sgst, ttl_cess }] */
export function summarizePayload(payload) {
  const out = [];
  const invSection = (name, groups, listKey) => {
    const t = blank(name);
    for (const g of groups || []) {
      for (const doc of g[listKey] || []) {
        t.ttl_rec += 1;
        t.ttl_val += num(doc.val);
        addItems(t, doc.itms);
      }
    }
    return t;
  };
  if (payload.b2b) out.push(invSection("B2B", payload.b2b, "inv"));
  if (payload.b2cl) out.push(invSection("B2CL", payload.b2cl, "inv"));
  if (payload.cdnr) out.push(invSection("CDNR", payload.cdnr, "nt"));
  if (payload.cdnur) {
    const t = blank("CDNUR");
    for (const nt of payload.cdnur) { t.ttl_rec += 1; t.ttl_val += num(nt.val); addItems(t, nt.itms); }
    out.push(t);
  }
  if (payload.b2cs) {
    const t = blank("B2CS");
    for (const r of payload.b2cs) {
      t.ttl_rec += 1;
      t.ttl_tax += num(r.txval);
      t.ttl_igst += num(r.iamt);
      t.ttl_cgst += num(r.camt);
      t.ttl_sgst += num(r.samt);
      t.ttl_cess += num(r.csamt);
    }
    out.push(t);
  }
  if (payload.nil) {
    const t = blank("NIL");
    for (const r of payload.nil.inv || []) { t.ttl_rec += 1; t.ttl_tax += num(r.nil_amt) + num(r.expt_amt) + num(r.ngsup_amt); }
    out.push(t);
  }
  if (payload.hsn) {
    const t = blank("HSN");
    for (const h of [...(payload.hsn.hsn_b2b || []), ...(payload.hsn.hsn_b2c || [])]) {
      t.ttl_rec += 1;
      t.ttl_tax += num(h.txval);
      t.ttl_igst += num(h.iamt);
      t.ttl_cgst += num(h.camt);
      t.ttl_sgst += num(h.samt);
      t.ttl_cess += num(h.csamt);
    }
    out.push(t);
  }
  if (payload.doc_issue) {
    const t = blank("DOC_ISSUE");
    for (const d of payload.doc_issue.doc_det_new || []) for (const s of d.docs || []) t.ttl_rec += num(s.net_issue);
    out.push(t);
  }
  return out.map(finish);
}

const LABELS = {
  B2B: "B2B Invoices", B2CL: "B2CL Invoices", B2CS: "B2CS Invoices", CDNR: "Credit/Debit Notes (Registered)",
  CDNUR: "Credit/Debit Notes (Unregistered)", NIL: "Nil Rated, Exempted & Non-GST", HSN: "HSN-wise Summary", DOC_ISSUE: "Documents Issued",
};
const AMOUNT_FIELDS = ["ttl_tax", "ttl_igst", "ttl_cgst", "ttl_sgst", "ttl_cess"];

/**
 * Compare what we saved with the portal's summary. Portal sections are
 * merged by prefix (HSN_B2B + HSN_B2C -> HSN). Notes are compared by
 * magnitude (the portal may report credit notes as negative). Sections only
 * on the portal with data (amendments, auto-populated e-invoices…) are
 * differences too. Documents Issued is informational.
 * @returns {{ rows: Array, mismatches: number }}
 */
export function compareSummary(payload, portalSecSum) {
  const ours = new Map(summarizePayload(payload).map((s) => [s.sec_nm, s]));
  const portal = new Map();
  for (const s of portalSecSum || []) {
    const name = String(s.sec_nm || "").toUpperCase();
    const key = name.startsWith("HSN") ? "HSN" : name;
    const t = portal.get(key) || blank(key);
    for (const f of ["ttl_rec", "ttl_val", ...AMOUNT_FIELDS]) t[f] += num(s[f]);
    portal.set(key, t);
  }

  const names = new Set([...ours.keys(), ...[...portal].filter(([, s]) => s.ttl_rec || s.ttl_tax).map(([k]) => k)]);
  const rows = [];
  for (const name of names) {
    const o = ours.get(name) || blank(name);
    const p = portal.get(name) || blank(name);
    const abs = name.startsWith("CDN") ? Math.abs : (x) => x;
    const diffs = {};
    if (o.ttl_rec !== num(p.ttl_rec) && name !== "DOC_ISSUE") diffs.records = { ours: o.ttl_rec, portal: num(p.ttl_rec) };
    for (const f of AMOUNT_FIELDS) {
      const d = r2(abs(num(p[f])) - abs(o[f]));
      if (Math.abs(d) > 1) diffs[f] = { ours: r2(o[f]), portal: r2(num(p[f])), diff: d };
    }
    const informational = name === "DOC_ISSUE";
    rows.push({
      section: name,
      label: LABELS[name] || name,
      ours: finish(o),
      portal: finish(p),
      diffs,
      match: informational || Object.keys(diffs).length === 0,
      onlyOnPortal: !ours.has(name),
      informational,
    });
  }
  return { rows, mismatches: rows.filter((r) => !r.match).length };
}
