// Pre-push guard for SAP-format sales uploads (bulkSalesV2.worker.js) —
// the sales counterpart of checkPurchaseExcelInvoice() in
// purchaseExcelBilling.js, same rules and the same ₹1 limit. Run by
// pushSalesInvoice.worker.js only for invoices tagged with
// source === SAP_UPLOAD_SOURCE; manual invoices and the old bulk upload are
// untouched.
import { roundTo2, MAX_ROUND_OFF } from "./purchaseExcelBilling.js";

export const SAP_UPLOAD_SOURCE = "sap_upload";

// Mirrors sales_generator.py's own round-off formula: grand_total minus
// (each line rounded, then summed + CGST + SGST + IGST − TDS + cess).
// Returns a list of problems; empty = OK.
//
// Unlike Purchase, there is deliberately NO per-line "quantity is 0" /
// "amount is 0" hold: SAP sales sheets legitimately carry service lines
// with quantity 0 (Dummy Material for Service Labour, FREE SERVICE, sublet
// — type of supply "Service") and free-of-charge lines with amount 0
// (warranty parts, free service). A dry run on the 564 stored SAP invoices
// showed those rules would hold ~99 genuine invoices, 51 of them already
// accepted by Tally.
export function checkSapSalesInvoice(invoice) {
  const problems = [];
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];

  if (items.length === 0) problems.push("invoice has no line items");

  const itemsTotal = roundTo2(items.reduce((s, i) => s + roundTo2(Math.abs(Number(i.amount || 0))), 0));
  const calculated = roundTo2(
    itemsTotal
    + Number(invoice.cgst_amount || 0) + Number(invoice.sgst_amount || 0) + Number(invoice.igst_amount || 0)
    - Math.abs(Number(invoice.tds_amount || 0))
    + Number(invoice.cess_amount || 0)
  );
  const roundOff = roundTo2(Math.abs(Number(invoice.grand_total || 0)) - calculated);
  if (Math.abs(roundOff) > MAX_ROUND_OFF) {
    problems.push(`round off would be ${roundOff} (total ${invoice.grand_total} vs items + tax − TDS ${calculated}); more than ₹${MAX_ROUND_OFF}`);
  }

  return [...new Set(problems)];
}
