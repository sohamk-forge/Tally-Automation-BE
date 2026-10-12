// src/services/ims/imsMatcher.js
//
// Pure matcher: IMS invoices (what suppliers filed, from WhiteBooks
// GET /ims/invoices) against the company's purchase vouchers synced from
// Tally. Proposes an IMS action per invoice:
//   MATCHED      -> "A" accept
//   MISMATCH     -> "P" pending (booked, but amounts/date disagree)
//   NOT_IN_BOOKS -> "P" pending (no purchase voucher for it)
// Never proposes "R" (reject); an invoice already rejected on the portal
// stays rejected. Where GSTN blocks "pending" (ispendactblocked = "Y") the
// user must choose accept or reject.
//
// Matching is by supplier GSTIN. The supplier's own invoice number (Tally
// REFERENCE, synced as vouchers.supplier_invoice_no) decides it when present;
// otherwise amounts + date do, with an invoice number found in the
// narration used to break ties. Vouchers synced before supplier_invoice_no
// existed have no number until they're re-synced.

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
export const normName = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const normDoc = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");

/** "24-07-2026" -> days since epoch (UTC), or null */
const dayNo = (ddmmyyyy) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(ddmmyyyy || ""));
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000 : null;
};

const DATE_WINDOW_DAYS = 45; // booking can lag the supplier's invoice date

/** IMS section -> which of our voucher kinds it can match. */
const SECTION_KIND = {
  B2B: "PURCHASE",
  B2BA: "PURCHASE",
  B2BDN: "PURCHASE",
  B2BDNA: "PURCHASE",
  B2BCN: "DEBIT_NOTE", // supplier's credit note = our purchase return (Debit Note in Tally)
  B2BCNA: "DEBIT_NOTE",
};

function lineRole(name) {
  const n = String(name || "");
  if (/round/i.test(n)) return "roundoff";
  if (/\b(tds|tcs)\b/i.test(n)) return "ignore";
  if (!/purchase|expense/i.test(n)) {
    if (/cess/i.test(n)) return "cess";
    if (/igst|integrated/i.test(n)) return "igst";
    if (/cgst|central\s*(gst|tax)/i.test(n)) return "cgst";
    if (/sgst|utgst|state\s*(gst|tax)/i.test(n)) return "sgst";
  }
  return "value";
}

/**
 * A purchase / debit-note voucher row -> amounts for matching.
 * row: { id, voucher_type, voucher_number, idt (DD-MM-YYYY), party_ledger_name, narration, ledger_entries, gstin,
 *        supplier_invoice_no?, supplier_invoice_idt? (DD-MM-YYYY), is_cancelled?, is_optional? }
 */
export function normalizePurchase(row) {
  if (row.is_cancelled || row.is_optional) return null;
  const entries = asArray(row.ledger_entries);
  const partyKey = normName(row.party_ledger_name);
  const party = entries.find((e) => normName(e.LEDGERNAME) === partyKey);
  if (!party || !num(party.AMOUNT)) return null;
  const s = -Math.sign(num(party.AMOUNT));
  const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const e of entries) {
    if (e === party) continue;
    const role = lineRole(e.LEDGERNAME);
    if (role === "roundoff" || role === "ignore") continue;
    const amt = num(e.AMOUNT) * s;
    if (role === "value") t.taxable += amt; else t[role] += amt;
  }
  const hint = /(?:invoice|inv|bill)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Za-z0-9/-]+)/i.exec(row.narration || "")?.[1] || null;
  const invoiceDate = row.supplier_invoice_idt || row.idt;
  return {
    voucherId: row.id,
    voucherNumber: row.voucher_number,
    voucherType: row.voucher_type,
    kind: /debit\s*note|purchase\s*return/i.test(row.voucher_type) ? "DEBIT_NOTE" : "PURCHASE",
    date: row.idt,
    // the supplier's invoice date when synced, else our booking date
    day: dayNo(invoiceDate),
    partyName: row.party_ledger_name,
    gstin: String(row.gstin || "").trim().toUpperCase() || null,
    taxable: r2(t.taxable),
    igst: r2(t.igst),
    cgst: r2(t.cgst),
    sgst: r2(t.sgst),
    cess: r2(t.cess),
    invoiceHint: hint,
    supplierInvoiceNo: row.supplier_invoice_no ? String(row.supplier_invoice_no).trim() : null,
  };
}

const imsKey = (i) => `${i.section}|${i.stin}|${normDoc(i.inum)}|${i.idt}`;

/**
 * @param {Array} imsInvoices  [{ section, stin, inum, idt, txval, iamt, camt, samt, cess, val, rtnprd, action, ispendactblocked, hash, ... }]
 * @param {Array} purchases    normalizePurchase() results
 * @returns {{ rows: Array, onlyInBooks: Array }}
 */
export function matchIms(imsInvoices, purchases) {
  const used = new Set();
  const byGstin = new Map();
  for (const p of purchases) {
    if (!p?.gstin) continue;
    const list = byGstin.get(p.gstin) || [];
    list.push(p);
    byGstin.set(p.gstin, list);
  }

  const compare = (inv, p) => {
    const tol = Math.max(1, num(inv.val) * 0.001);
    const diffs = {
      taxable: r2(num(inv.txval) - p.taxable),
      igst: r2(num(inv.iamt) - p.igst),
      cgst: r2(num(inv.camt) - p.cgst),
      sgst: r2(num(inv.samt) - p.sgst),
      cess: r2(num(inv.cess) - p.cess),
    };
    const amountsOk = Object.values(diffs).every((d) => Math.abs(d) <= tol);
    const dDays = inv.day != null && p.day != null ? Math.abs(inv.day - p.day) : 9999;
    // Same supplier invoice number = the same document, whatever the date.
    const refMatch = !!p.supplierInvoiceNo && normDoc(inv.inum) === normDoc(p.supplierInvoiceNo);
    const hint = refMatch || (!!p.invoiceHint && (normDoc(inv.inum) === normDoc(p.invoiceHint) || normDoc(inv.inum).endsWith(normDoc(p.invoiceHint))));
    return { p, diffs, amountsOk, dDays, hint, refMatch, closeness: Math.abs(diffs.taxable) + Math.abs(diffs.igst + diffs.cgst + diffs.sgst) };
  };

  const invs = imsInvoices.map((i) => ({ ...i, key: imsKey(i), day: dayNo(i.idt), wantKind: SECTION_KIND[i.section] || "PURCHASE" }));
  const candidatesFor = (inv) => (byGstin.get(String(inv.stin).toUpperCase()) || []).filter((p) => p.kind === inv.wantKind);

  // Pass 1: exact pairs (amounts agree, date within the window), assigned
  // one-to-one, best first (narration hint, then nearest date).
  const exact = [];
  for (const inv of invs) {
    for (const p of candidatesFor(inv)) {
      const c = compare(inv, p);
      if (c.amountsOk && (c.dDays <= DATE_WINDOW_DAYS || c.hint)) exact.push({ inv, ...c });
    }
  }
  exact.sort((a, b) => (b.refMatch ? 1 : 0) - (a.refMatch ? 1 : 0) || (b.hint ? 1 : 0) - (a.hint ? 1 : 0) || a.dDays - b.dDays);
  const matchOf = new Map();
  for (const m of exact) {
    if (matchOf.has(m.inv.key) || used.has(m.p.voucherId)) continue;
    matchOf.set(m.inv.key, m);
    used.add(m.p.voucherId);
  }

  const rows = invs.map((inv) => {
    const portalAction = inv.action || "N";
    let status;
    let best = matchOf.get(inv.key) || null;
    let note;
    if (best) {
      status = "MATCHED";
      note = `Matches voucher ${best.p.voucherNumber} dated ${best.p.date}${best.refMatch ? " (same supplier invoice number)" : ""}`;
      if (best.dDays > 3 && best.dDays !== 9999) note += ` (booked ${best.dDays} days from the invoice date — check the date in Tally)`;
    } else {
      // Pass 2: closest unused voucher from the same supplier, to explain why.
      const near = candidatesFor(inv)
        .filter((p) => !used.has(p.voucherId))
        .map((p) => compare(inv, p))
        .sort((a, b) => (b.refMatch ? 1 : 0) - (a.refMatch ? 1 : 0) || (b.hint ? 1 : 0) - (a.hint ? 1 : 0) || a.closeness - b.closeness || a.dDays - b.dDays)[0];
      const related = near && (near.hint || Math.abs(near.diffs.taxable) <= Math.max(1, num(inv.txval) * 0.05) || near.amountsOk);
      if (related) {
        status = "MISMATCH";
        best = near;
        const parts = [];
        if (Math.abs(near.diffs.taxable) > 0) parts.push(`taxable differs by ₹${near.diffs.taxable}`);
        const taxDiff = r2(near.diffs.igst + near.diffs.cgst + near.diffs.sgst + near.diffs.cess);
        if (Math.abs(taxDiff) > 0) parts.push(`tax differs by ₹${taxDiff}`);
        if (near.amountsOk && near.dDays > DATE_WINDOW_DAYS) parts.push(`booked ${near.dDays} days apart`);
        note = `${near.refMatch ? "Booked as voucher" : "Closest is voucher"} ${near.p.voucherNumber} (${near.p.date}): ${parts.join(", ") || "amounts differ"}`;
      } else {
        status = "NOT_IN_BOOKS";
        note = byGstin.has(String(inv.stin).toUpperCase())
          ? "Supplier is in your books, but no purchase voucher matches this invoice"
          : "No purchase voucher from this supplier GSTIN in your books";
      }
    }

    // Proposed action per the rule: match -> accept, otherwise pending.
    let proposed = status === "MATCHED" ? "A" : "P";
    let needsDecision = false;
    if (portalAction === "R") {
      proposed = "R"; // never undo a rejection made on the portal
      note += " · already rejected on the GST portal";
    } else if (proposed === "P" && inv.ispendactblocked === "Y") {
      proposed = null; // GSTN won't allow pending here: user picks accept or reject
      needsDecision = true;
      note += " · GSTN doesn't allow 'pending' for this invoice — choose accept or reject";
    }

    const itc = r2(num(inv.iamt) + num(inv.camt) + num(inv.samt) + num(inv.cess));
    return {
      key: inv.key,
      section: inv.section,
      stin: inv.stin,
      inum: inv.inum,
      idt: inv.idt,
      rtnprd: inv.rtnprd,
      invTyp: inv.inv_typ,
      pos: inv.pos,
      val: num(inv.val),
      txval: num(inv.txval),
      iamt: num(inv.iamt),
      camt: num(inv.camt),
      samt: num(inv.samt),
      cess: num(inv.cess),
      itc,
      srcform: inv.srcform,
      hash: inv.hash,
      src: inv.src || null,
      supFilingDt: inv.supFilingDt,
      pendingBlocked: inv.ispendactblocked === "Y",
      portalAction,
      status,
      proposed,
      needsDecision,
      note,
      voucher: best ? { id: best.p.voucherId, number: best.p.voucherNumber, date: best.p.date, party: best.p.partyName, taxable: best.p.taxable, tax: r2(best.p.igst + best.p.cgst + best.p.sgst + best.p.cess) } : null,
      diffs: best && status === "MISMATCH" ? best.diffs : null,
    };
  });

  return { rows, usedVoucherIds: used };
}
