// src/services/gstr3b/rcm.js
//
// Reverse-charge (RCM) purchases from the books, for GSTR-3B 3.1(d) and ITC
// 4(A)(3). Tally has no RCM flag on the synced voucher, so a voucher counts
// as RCM when it carries GST ledgers named for reverse charge ("Input CGST
// RCM", "Output IGST - Reverse Charge", ...). Tax is read from the liability
// ("Output"/"Payable") ledgers; with only unlabelled RCM ledgers, the pair of
// input/output postings is counted once.

import { lineRole } from "../ims/imsMatcher.js";

const RCM_RE = /\b(rcm|reverse\s*charge)\b/i;
const LIABILITY_RE = /output|payable|liab/i;
const HEADS = ["igst", "cgst", "sgst", "cess"];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/**
 * @param {object} row a purchase voucher row (loadPurchases)
 * @returns {{ taxable, igst, cgst, sgst, cess, voucherNumber, partyName, supplyKind }|null}
 */
export function rcmOfVoucher(row) {
  if (!row || row.is_cancelled || row.is_optional) return null;
  const entries = asArray(row.ledger_entries);
  const rcmEntries = entries.filter((e) => RCM_RE.test(String(e.LEDGERNAME || "")) && HEADS.includes(lineRole(e.LEDGERNAME)));
  if (!rcmEntries.length) return null;

  const tax = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const head of HEADS) {
    const list = rcmEntries.filter((e) => lineRole(e.LEDGERNAME) === head);
    if (!list.length) continue;
    const liab = list.filter((e) => LIABILITY_RE.test(String(e.LEDGERNAME)));
    if (liab.length) tax[head] = liab.reduce((a, e) => a + Math.abs(num(e.AMOUNT)), 0);
    else tax[head] = list.reduce((a, e) => a + Math.abs(num(e.AMOUNT)), 0) / (list.length > 1 ? 2 : 1);
  }

  // Taxable value: the party's side of the voucher, less the GST ledgers.
  const partyKey = String(row.party_ledger_name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const party = entries.find((e) => String(e.LEDGERNAME || "").trim().toLowerCase().replace(/\s+/g, " ") === partyKey);
  const sign = party && num(party.AMOUNT) ? -Math.sign(num(party.AMOUNT)) : -1;
  let taxable = 0;
  for (const e of entries) {
    if (e === party || rcmEntries.includes(e)) continue;
    if (lineRole(e.LEDGERNAME) === "value") taxable += num(e.AMOUNT) * sign;
  }
  taxable = Math.abs(taxable);

  return {
    voucherId: row.id,
    voucherNumber: row.voucher_number,
    partyName: row.party_ledger_name,
    taxable: r2(taxable),
    igst: r2(tax.igst), cgst: r2(tax.cgst), sgst: r2(tax.sgst), cess: r2(tax.cess),
  };
}

/** All RCM purchases of a period; empty array when the books show none. */
export function rcmFromPurchases(rows) {
  return (rows || []).map(rcmOfVoucher).filter(Boolean);
}
