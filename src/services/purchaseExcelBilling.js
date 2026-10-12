/* =====================================================================
   PURCHASE EXCEL — "what did the vendor actually bill on this line?"

   Single source of truth for the billed qty / taxable / tax / total of a
   purchase_po_lines row. Shared by the push path
   (bulkPurchase.worker.js's pushMatchedLinesToInvoices), the
   reconciliation amount checks (bulkPurchaseUpload.routes.js) and
   scripts/audit-purchase-excel-billing.js, so all three always agree.

   The Purchase Report carries two families of columns:
     PO side:      Quantity, GR Qty., GR Amount, Total Taxable Amount,
                   Tax Amount, Amount — the PO-ordered quantity and its
                   value. Wrong for partial deliveries (Quantity 6 when
                   the vendor billed 2) and all-zero on some order types
                   (ZTEP rows carry Total Taxable Amount 0.00).
     Invoice side: Vendor Invoice Qty., VECV Invoice Net Val — what the
                   vendor's own invoice billed for this line.
   The invoice side wins. GR Qty. / GR Amount are the fallback. The PO-side
   Quantity / Total Taxable Amount / Amount are NEVER used for what gets
   pushed — a line with neither source is held for review instead
   (reviewReasons), not silently filled from the PO.
   ===================================================================== */

export function roundTo2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Purchase Report's own "Tax Description" states the rate per line, e.g.
// "IGST Input 18%" or "CGST & SGST Input 18%".
export function parseGstRatePercent(taxDescription) {
  const match = String(taxDescription || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

// Fallback for lines where Tax Description has no literal "%" — back the
// rate out of the sheet's own taxable/tax pair. A ratio, so it's still
// valid even when both are PO-level rather than per-delivery figures.
export function deriveGstRateFromAmounts(taxableAmount, taxAmount) {
  const taxable = Number(taxableAmount || 0);
  const tax = Number(taxAmount || 0);
  if (taxable <= 0 || tax <= 0) return null;
  return roundTo2((tax / taxable) * 100);
}

export function isIgst(taxDescription) {
  return /igst/i.test(taxDescription || "");
}

export function computeBilledLine(row) {
  const reviewReasons = [];
  const label = row.material_description || row.material_code || "line";

  const vendorInvoiceQty = Number(row.vendor_invoice_qty) || 0;
  const grQty = Number(row.gr_quantity) || 0;
  const billedQty = vendorInvoiceQty > 0 ? vendorInvoiceQty : grQty > 0 ? grQty : 0;
  if (billedQty <= 0) {
    reviewReasons.push(`"${label}": Vendor Invoice Qty. and GR Qty. are both 0/blank`);
  }

  const netVal = Number(row.vendor_invoice_net_val) || 0;
  const grAmount = Number(row.gr_amount) || 0;
  const billedTaxable = roundTo2(netVal > 0 ? netVal : grAmount > 0 ? grAmount : 0);
  if (billedTaxable <= 0) {
    reviewReasons.push(`"${label}": VECV Invoice Net Val and GR Amount are both 0/blank`);
  }

  const gstRate = parseGstRatePercent(row.tax_description)
    ?? deriveGstRateFromAmounts(row.taxable_amount, row.tax_amount);
  if (gstRate === null) {
    reviewReasons.push(`"${label}": GST rate not found in Tax Description "${row.tax_description || ""}"`);
  }

  const billedTax = roundTo2(billedTaxable * (gstRate || 0) / 100);
  const billedAmount = roundTo2(billedTaxable + billedTax);

  return { billedQty, billedTaxable, billedTax, billedAmount, gstRate, reviewReasons };
}

// Tally "Round Off" convention: paise <= 0.50 rounds down, > 0.50 rounds up.
export function roundToNearestRupee(amount) {
  const rupees = Math.floor(amount);
  const paise = roundTo2(amount - rupees);
  return paise <= 0.5 ? rupees : rupees + 1;
}

// Builds the invoice_extractions.raw_json for one vendor invoice from its
// purchase_po_lines rows. Pure — no DB — so the audit script can compare
// what would be pushed now against what was pushed before.
export function buildPurchaseExcelInvoice(invoiceNo, lines, { purchaseLedger, vendorGstin }) {
  const first = lines[0];
  const billedLines = lines.map((l) => ({ l, ...computeBilledLine(l) }));

  // VECV Invoice Net Val is per line, not an invoice total repeated on
  // every row — confirmed against Apr–Aug 2026 Spare Statements: invoices
  // with the same part on several PO lines (same net val on each) sum to
  // the statement debit only when every line's value is counted.
  const reviewReasons = billedLines.flatMap((b) => b.reviewReasons);

  const taxableTotal = roundTo2(billedLines.reduce((sum, b) => sum + b.billedTaxable, 0));
  const taxTotal = roundTo2(billedLines.reduce((sum, b) => sum + b.billedTax, 0));
  const igst = isIgst(first.tax_description);

  // Total is always taxable + tax — never the sheet's Amount column (a
  // ZTEP row's Amount was the tax alone, which pushed a 4,099 voucher
  // with a -22,775.50 round off). Round off is therefore always <= 0.50.
  const cgst = igst ? 0 : roundTo2(taxTotal / 2);
  const sgst = igst ? 0 : roundTo2(taxTotal - cgst);
  const rawGrandTotal = roundTo2(taxableTotal + taxTotal);
  const roundedGrandTotal = roundToNearestRupee(rawGrandTotal);
  const roundOff = roundTo2(roundedGrandTotal - rawGrandTotal);

  const poNumbers = [...new Set(lines.map((l) => l.po_no))];
  // A voucher can span several PO lines, each with its own ODN.
  const odnNumbers = [...new Set(lines.map((l) => l.odn).filter(Boolean))];

  const lineItems = billedLines.map(({ l, billedQty, billedTaxable, gstRate }) => ({
    item_name: l.material_description,
    qty: billedQty,
    unit: l.unit || "",
    unit_of_measure: l.unit || "",
    hsn_code: l.hsn_code || "",
    rate: billedQty ? roundTo2(billedTaxable / billedQty) : 0,
    amount: billedTaxable,
    godown_name: l.godown_name || "",
    gst_rate: gstRate
  }));

  const narration = `Being purchase from ${first.vendor_name} vide invoice ${invoiceNo} dated ${first.invoice_date || ""} (PO: ${poNumbers.join(", ")}) (ODN: ${odnNumbers.join(", ")})`;

  return {
    vendor_name: first.vendor_name,
    gstin: vendorGstin || "",
    invoice_no: invoiceNo,
    invoice_date: first.invoice_date,
    line_items: lineItems,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst ? taxTotal : 0,
    tds_amount: 0,
    cess_amount: 0,
    taxable_amount: taxableTotal,
    grand_total: roundedGrandTotal,
    round_off: roundOff,
    narration,
    purchase_ledger: purchaseLedger,
    po_numbers: poNumbers,
    odn_numbers: odnNumbers,
    godown_name: first.godown_name || "",
    // Read by pushInvoice.worker.js — non-empty holds the invoice as
    // Needs Review instead of pushing. Cleared when a user saves the
    // invoice from the edit modal (PUT /invoices/:id).
    review_reasons: reviewReasons
  };
}

// Pre-push guard for Purchase Excel invoices (pushInvoice.worker.js).
// Mirrors generator.py's own round-off formula: grand_total minus
// (items + CGST + SGST + IGST). Returns a list of problems; empty = OK.
export const MAX_ROUND_OFF = 1;

export function checkPurchaseExcelInvoice(invoice) {
  const problems = [...(invoice.review_reasons || [])];
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];

  items.forEach((item) => {
    const name = item.item_name || item.name || "line";
    if (!(Number(item.qty) > 0)) problems.push(`"${name}": quantity is 0`);
    if (!(Number(item.amount) > 0)) problems.push(`"${name}": amount is 0`);
  });

  const calculated = roundTo2(
    items.reduce((s, i) => s + Number(i.amount || 0), 0)
    + Number(invoice.cgst_amount || 0) + Number(invoice.sgst_amount || 0) + Number(invoice.igst_amount || 0)
  );
  const roundOff = roundTo2(Number(invoice.grand_total || 0) - calculated);
  if (Math.abs(roundOff) > MAX_ROUND_OFF) {
    problems.push(`round off would be ${roundOff} (total ${invoice.grand_total} vs items + tax ${calculated}); more than ₹${MAX_ROUND_OFF}`);
  }

  return [...new Set(problems)];
}
