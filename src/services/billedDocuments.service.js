// src/services/billedDocuments.service.js
//
// After a Sales Invoice is pushed from "Bills to be Made", the delivery
// challans / approved quotations it was billed against must drop out of that
// list. Extracted from the sales-invoice route so it can be tested directly.
//
// Challans and quotations used to be numbered independently (both 0001,
// 0002…), so each entry's `source` says which table it belongs to. Entries
// without a source come from a browser tab still running the older frontend;
// they can't say which table they mean, so they're matched by number AND the
// invoice's customer — which keeps another customer's same-numbered document
// from being consumed.

import { markChallansInvoiced } from "./challan.service.js";
import { markQuotationsPushed } from "./quotation.service.js";

export async function markBilledDocuments(companyId, billedSources, customerName, log = console) {
  const sources = Array.isArray(billedSources) ? billedSources : [];
  const numbersFor = (pick) => sources
    .filter((dc) => pick(dc?.source))
    .map((dc) => dc?.number)
    .filter(Boolean);

  const challanNumbers = numbersFor((s) => s === "challan");
  const quotationNumbers = numbersFor((s) => s === "quotation");
  const untaggedNumbers = numbersFor((s) => s !== "challan" && s !== "quotation");
  const invoiceCustomer = String(customerName || "").trim() || null;

  const result = { challans: 0, quotations: 0, untaggedChallans: 0, untaggedQuotations: 0 };

  const markBilled = async (label, fn, numbers, customer) => {
    if (!numbers.length) return 0;
    try {
      const n = await fn(companyId, numbers, customer);
      log.log(`Marked ${n} ${label}:`, numbers);
      return n;
    } catch (markErr) {
      // Non-fatal — the invoice itself already succeeded and is queued.
      log.error(`Failed to mark ${label}:`, markErr.message);
      return 0;
    }
  };

  result.challans = await markBilled("challan(s) as invoiced", markChallansInvoiced, challanNumbers, null);
  result.quotations = await markBilled("quotation(s) as pushed to Tally", markQuotationsPushed, quotationNumbers, null);
  // Untagged + no customer on the invoice: nothing safe to match on.
  if (invoiceCustomer) {
    result.untaggedChallans = await markBilled("untagged challan(s) as invoiced", markChallansInvoiced, untaggedNumbers, invoiceCustomer);
    result.untaggedQuotations = await markBilled("untagged quotation(s) as pushed to Tally", markQuotationsPushed, untaggedNumbers, invoiceCustomer);
  }
  return result;
}
