import puppeteer from "puppeteer";
import { amountToWords } from "../utils/numberToWords.js";

/**
 * voucherPdfRenderer.service.js
 * ================================
 * Everything - shared styles, layout partials, and all 6 voucher templates -
 * lives in this one file as plain JS functions that return HTML strings.
 */

// ---------- tiny helpers ----------

/** Escapes user-entered text (ledger names, narration, etc.) before dropping into HTML */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}

// ---------- logo ----------

/**
 * Renders the company logo if one is present on the company object
 * (company.logoDataUri — a full "data:image/png;base64,..." string built
 * by companyLogo.service.js from the persisted companies.logo_data column).
 * Renders nothing if there is no logo, so the header lays out cleanly with
 * just the name/address block flush left — no placeholder box, no broken
 * image icon.
 */
function logoHtml(company) {
  if (!company || !company.logoDataUri) return "";
  return `<img src="${company.logoDataUri}" class="company-logo-img" alt="Company Logo" />`;
}

// ---------- shared style ----------

const SHARED_STYLE = `
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; padding: 16px; }
  .sheet { border: 1px solid #000; }

  .company-header { display: flex; align-items: flex-start; gap: 14px; padding: 10px 12px; border-bottom: 1px solid #000; }
  .company-logo-img { width: 110px; max-height: 70px; height: auto; object-fit: contain; flex-shrink: 0; }
  .company-name { font-size: 17px; font-weight: bold; color: #1a5fb4; margin: 0 0 3px 0; line-height: 1.25; }
  .company-meta { font-size: 10.5px; line-height: 1.5; color: #333; }
  .company-meta strong { color: #111; }

  .voucher-title { text-align: center; font-weight: bold; font-size: 14px; padding: 6px 0; border-bottom: 2px solid #1a5fb4; background: #ffffff; color: #1a5fb4; }

  /* ---- Info row (voucher no / date / order no) ---- */
  table.info-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.info-table td {
    border-bottom: 1px solid #000;
    padding: 5px 8px;
    vertical-align: top;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  table.info-table td.label { font-weight: bold; white-space: nowrap; color: #333; }

  /* ---- Consignee / Buyer block ---- */
  .party-block { display: flex; border-bottom: 1px solid #000; }
  .party-block .half { flex: 1; padding: 6px 8px; }
  .party-block .half:first-child { border-right: 1px solid #000; }
  .party-block .name { font-weight: bold; }

  /* ---- Item / party table: full grid, plain black headers ---- */
  table.data-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.data-table th, table.data-table td {
    border: 1px solid #000;
    padding: 5px 8px;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  table.data-table th { background: #f4f6f9; text-align: left; font-weight: bold; color: #111; }
  table.data-table td.num, table.data-table th.num { text-align: right; }
  table.data-table tr.total-row td { font-weight: bold; }
  .words-row { display: flex; justify-content: space-between; border-top: 1px solid #000; padding: 6px 8px; font-weight: bold; }
  .amount-words { border-top: 1px solid #000; padding: 6px 8px; font-weight: bold; }

  /* ---- Tax breakdown table: full grid, plain black headers ---- */
  table.tax-table { width: 100%; border-collapse: collapse; }
  table.tax-table th, table.tax-table td { border: 1px solid #000; padding: 3px 6px; text-align: right; }
  table.tax-table th { background: #f4f6f9; color: #111; }
  table.tax-table td.left, table.tax-table th.left { text-align: left; }

  /* ---- Signature block: both columns equal height, labels pinned to bottom ---- */
  .signature-block { display: flex; border-top: 1px solid #000; min-height: 95px; }
  .signature-left {
    flex: 1;
    padding: 8px 10px;
    border-right: 1px solid #000;
    display: flex;
    align-items: flex-end;
  }
  .signature-right { flex: 1; padding: 8px 10px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; text-align: right; }
  .signature-right .for-company { text-align: right; white-space: nowrap; font-size: 10.5px; }
  .signature-right .auth-label { text-align: right; }

  .jurisdiction-footer { text-align: center; border-top: 1px solid #000; padding: 4px 0; font-size: 10px; color: #555; }

  .ledger-transaction { padding: 7px 8px; border-top: 1px solid #000; font-size: 10.5px; background: #fafbfc; }
  .ledger-transaction .title { font-weight: bold; color: #1a5fb4; }
</style>`;

function headerHtml(company, title) {
  return `
<div class="company-header">
  ${logoHtml(company)}
  <div>
    <p class="company-name">${esc(company.name)}</p>
    <div class="company-meta">
      ${esc(company.address)}<br/>
      Email: ${esc(company.email)}<br/>
      GSTIN: <strong>${esc(company.gstin)}</strong> | State: ${esc(company.state)}
    </div>
  </div>
</div>
<div class="voucher-title">${esc(title)}</div>`;
}

function signatureHtml(company) {
  return `
<div class="signature-block">
  <div class="signature-left">Receiver's Seal and Signature</div>
  <div class="signature-right">
    <div class="for-company">for <strong>${esc(company.name)}</strong></div>
    <div class="auth-label">Authorised Signatory</div>
  </div>
</div>`;
}

function invoiceFooterHtml(company) {
  return `
<div class="jurisdiction-footer">
  This is a Computer Generated Invoice
</div>`;
}

function wrap(bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />${SHARED_STYLE}</head><body><div class="sheet">${bodyHtml}</div></body></html>`;
}

// ---------- round off row builder shared by purchase + sales ----------

/**
 * Renders the "Round Off" row for the items table, if a round-off amount
 * was extracted from ledger_entries. Negative amounts (debit round-off,
 * i.e. total was rounded down) are shown with a leading "(-)" the way
 * Tally itself prints it; positive amounts (credit round-off, rounded up)
 * are shown plain.
 */
function buildRoundOffRowHtml(roundOff) {
  if (!roundOff) return "";
  const sign = roundOff < 0 ? "(-) " : "";
  return `<tr><td colspan="6"><em>Round Off</em></td><td class="num">${sign}${money(Math.abs(roundOff))}</td></tr>`;
}

// ---------- tax-table builder shared by purchase + sales ----------

function buildTaxRows(items, cgstTotal, sgstTotal, igstTotal, chargesTotal = 0) {
  const grouped = {};
  for (const item of items) {
    const key = item.hsnSac || "N/A";
    if (!grouped[key]) grouped[key] = { hsnSac: key, taxableValue: 0 };
    grouped[key].taxableValue += item.amount;
  }

  // additionalCharges (e.g. Handling Charges) carry no HSN of their own but
  // are still part of the value GST was calculated on. Apportion them into
  // each group's taxableValue using that group's existing item-value share,
  // so the displayed rate (amt / taxableValue) reflects the true rate
  // instead of being inflated by an undercounted denominator.
  const totalItemTaxable = Object.values(grouped).reduce((s, g) => s + g.taxableValue, 0) || 1;
  if (chargesTotal) {
    for (const g of Object.values(grouped)) {
      const itemShare = g.taxableValue / totalItemTaxable;
      g.taxableValue += chargesTotal * itemShare;
    }
  }

  const totalTaxable = Object.values(grouped).reduce((s, g) => s + g.taxableValue, 0) || 1;

  return Object.values(grouped).map((g) => {
    const share = g.taxableValue / totalTaxable;
    const cgstAmount = cgstTotal * share;
    const sgstAmount = sgstTotal * share;
    const igstAmount = igstTotal * share;
    const rate = (amt) => (g.taxableValue ? Math.round((amt / g.taxableValue) * 10000) / 100 : 0);
    return {
      ...g,
      cgstAmount, sgstAmount, igstAmount,
      cgstRate: rate(cgstAmount), sgstRate: rate(sgstAmount), igstRate: rate(igstAmount),
      totalTax: cgstAmount + sgstAmount + igstAmount,
    };
  });
}

function buildTaxTableHtml(v) {
  const chargesTotal = (v.additionalCharges || []).reduce((s, c) => s + c.amount, 0);
  const taxRows = buildTaxRows(v.items, v.cgst, v.sgst, v.igst, chargesTotal);
  const isInterstate = v.igst > 0;

  if (isInterstate) {
    return `
    <table class="tax-table">
      <tr><th class="left">HSN/SAC</th><th>Taxable Value</th><th>IGST Rate</th><th>Amount</th><th>Total Tax Amt</th></tr>
      ${taxRows.map((r) => `
        <tr>
          <td class="left">${esc(r.hsnSac)}</td>
          <td>${money(r.taxableValue)}</td>
          <td>${r.igstRate}%</td>
          <td>${money(r.igstAmount)}</td>
          <td>${money(r.totalTax)}</td>
        </tr>`).join("")}
      <tr class="total-row">
        <td class="left">Total</td>
        <td>${money(taxRows.reduce((s, r) => s + r.taxableValue, 0))}</td>
        <td></td><td>${money(v.igst)}</td><td>${money(v.igst)}</td>
      </tr>
    </table>`;
  }

  return `
    <table class="tax-table">
      <tr><th class="left">HSN/SAC</th><th>Taxable Value</th><th>CGST Rate</th><th>Amount</th><th>SGST/UTGST Rate</th><th>Amount</th><th>Total Tax Amt</th></tr>
      ${taxRows.map((r) => `
        <tr>
          <td class="left">${esc(r.hsnSac)}</td>
          <td>${money(r.taxableValue)}</td>
          <td>${r.cgstRate}%</td><td>${money(r.cgstAmount)}</td>
          <td>${r.sgstRate}%</td><td>${money(r.sgstAmount)}</td>
          <td>${money(r.totalTax)}</td>
        </tr>`).join("")}
      <tr class="total-row">
        <td class="left">Total</td>
        <td>${money(taxRows.reduce((s, r) => s + r.taxableValue, 0))}</td>
        <td></td><td>${money(v.cgst)}</td>
        <td></td><td>${money(v.sgst)}</td>
        <td>${money(v.cgst + v.sgst)}</td>
      </tr>
    </table>`;
}

function taxAmountWordsFor(v) {
  const totalTax = (v.cgst || 0) + (v.sgst || 0) + (v.igst || 0);
  return amountToWords(totalTax);
}

// ---------- one builder function per voucher type ----------

function buildContraHtml(v) {
  const rows = v.ledgerEntries.map(
    (e) => `
      <tr>
        <td>${e.debit ? "By " : "To "}${esc(e.ledgerName)}</td>
        <td class="num">${e.debit ? money(e.debit) : ""}</td>
        <td class="num">${e.credit ? money(e.credit) : ""}</td>
      </tr>`
  ).join("");

  return wrap(`
    ${headerHtml(v.company, "Contra Voucher")}
    <table class="info-table">
      <colgroup>
        <col style="width:9%"><col style="width:27%">
        <col style="width:9%"><col style="width:55%">
      </colgroup>
      <tr>
        <td class="label">Voucher No.</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
      </tr>
      <tr>
        <td class="label">Bank A/C</td>
        ${v.narration
          ? `<td>${esc(v.bankAccount || v.partyName)}</td><td class="label">Narration</td><td>${esc(v.narration)}</td>`
          : `<td colspan="3">${esc(v.bankAccount || v.partyName)}</td>`}
      </tr>
    </table>
    <table class="data-table">
      <colgroup>
        <col style="width:60%"><col style="width:20%"><col style="width:20%">
      </colgroup>
      <tr><th>Particulars</th><th class="num">Debit</th><th class="num">Credit</th></tr>
      ${rows}
      <tr class="total-row">
        <td>Total</td><td class="num">${money(v.total)}</td><td class="num">${money(v.total)}</td>
      </tr>
    </table>
    <div class="words-row">
      <div>${esc(amountToWords(v.total))}</div>
      <div>Total : Rs. ${money(v.total)}</div>
    </div>
    ${signatureHtml(v.company)}
  `);
}

function buildJournalHtml(v) {
  const rows = v.ledgerEntries.map(
    (e) => `
      <tr>
        <td>${e.debit ? "By " : "To "}${esc(e.ledgerName)}</td>
        <td class="num">${e.debit ? money(e.debit) : ""}</td>
        <td class="num">${e.credit ? money(e.credit) : ""}</td>
      </tr>`
  ).join("");

  return wrap(`
    ${headerHtml(v.company, "Journal Voucher")}
    <table class="info-table">
      <colgroup>
        <col style="width:9%"><col style="width:27%">
        <col style="width:9%"><col style="width:55%">
      </colgroup>
      <tr>
        <td class="label">Voucher No.</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
      </tr>
      <tr>
        <td class="label">Party</td>
        ${v.narration
          ? `<td>${esc(v.partyName)}</td><td class="label">Narration</td><td>${esc(v.narration)}</td>`
          : `<td colspan="3">${esc(v.partyName)}</td>`}
      </tr>
    </table>
    <table class="data-table">
      <colgroup>
        <col style="width:60%"><col style="width:20%"><col style="width:20%">
      </colgroup>
      <tr><th>Particulars</th><th class="num">Debit</th><th class="num">Credit</th></tr>
      ${rows}
      <tr class="total-row">
        <td>Total</td><td class="num">${money(v.total)}</td><td class="num">${money(v.total)}</td>
      </tr>
    </table>
    <div class="words-row">
      <div>${esc(amountToWords(v.total))}</div>
      <div>Total : Rs. ${money(v.total)}</div>
    </div>
    ${signatureHtml(v.company)}
  `);
}

function buildPaymentHtml(v) {
  const openLabel = v.openingBalance >= 0 ? "(Dr)" : "(Cr)";
  const closeLabel = v.closingBalance >= 0 ? "(Dr)" : "(Cr)";

  const partyRows = v.parties.map(
    (p) => `
      <tr>
        <td>${esc(p.partyName)}${v.narration ? `<br/>Narration : ${esc(v.narration)}` : ""}</td>
        <td class="num">${money(p.amount)}</td>
      </tr>`
  ).join("");

  return wrap(`
    ${headerHtml(v.company, "Payment Voucher")}
    <table class="info-table">
      <colgroup>
        <col style="width:12%"><col style="width:38%">
        <col style="width:12%"><col style="width:38%">
      </colgroup>
      <tr>
        <td class="label">Voucher No.</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
      </tr>
      <tr>
        <td class="label">Bank Account</td><td colspan="3">${esc(v.bankAccount)}</td>
      </tr>
    </table>
    <table class="data-table">
      <colgroup>
        <col style="width:78%"><col style="width:22%">
      </colgroup>
      <tr><th>Particulars</th><th class="num">Amount</th></tr>
      ${partyRows}
      <tr class="total-row">
        <td>Total</td><td class="num">${money(v.amount)}</td>
      </tr>
    </table>
    <div class="ledger-transaction">
      <div class="title">Ledger Transaction:</div>
      Opening Balance : ${openLabel} ${money(Math.abs(v.openingBalance))}<br/>
      This Payment Amount : ${money(v.amount)}<br/>
      <strong>Closing Balance : ${closeLabel} ${money(Math.abs(v.closingBalance))}</strong>
    </div>
    <div class="words-row">
      <div>Amount Chargeable (in Words)</div>
      <div>Total : ${money(v.amount)}</div>
    </div>
    <div class="amount-words">${esc(amountToWords(v.amount))}</div>
    ${signatureHtml(v.company)}
  `);
}

function buildReceiptHtml(v) {
  const openLabel = v.openingBalance >= 0 ? "(Dr)" : "(Cr)";
  const closeLabel = v.closingBalance >= 0 ? "(Dr)" : "(Cr)";

  const partyRows = v.parties.map(
    (p) => `
      <tr>
        <td>${esc(p.partyName)}${v.narration ? `<br/>Narration : ${esc(v.narration)}` : ""}</td>
        <td class="num">${money(p.amount)}</td>
      </tr>`
  ).join("");

  return wrap(`
    ${headerHtml(v.company, "Receipt Voucher")}
    <table class="info-table">
      <colgroup>
        <col style="width:12%"><col style="width:38%">
        <col style="width:12%"><col style="width:38%">
      </colgroup>
      <tr>
        <td class="label">Voucher No.</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
      </tr>
      <tr>
        <td class="label">Bank Account</td><td colspan="3">${esc(v.bankAccount)}</td>
      </tr>
    </table>
    <table class="data-table">
      <colgroup>
        <col style="width:78%"><col style="width:22%">
      </colgroup>
      <tr><th>Particulars</th><th class="num">Amount</th></tr>
      ${partyRows}
      <tr class="total-row">
        <td>Total</td><td class="num">${money(v.amount)}</td>
      </tr>
    </table>
    <div class="ledger-transaction">
      <div class="title">Ledger Transaction:</div>
      Opening Balance : ${openLabel} ${money(Math.abs(v.openingBalance))}<br/>
      This Receipt Amount : ${money(v.amount)}<br/>
      <strong>Closing Balance : ${closeLabel} ${money(Math.abs(v.closingBalance))}</strong>
    </div>
    <div class="words-row">
      <div>Amount Chargeable (in Words)</div>
      <div>Total : ${money(v.amount)}</div>
    </div>
    <div class="amount-words">${esc(amountToWords(v.amount))}</div>
    ${signatureHtml(v.company)}
  `);
}

function buildPurchaseHtml(v) {
  const itemRows = v.items.map(
    (item, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${esc(item.stockItemName)}</strong></td>
        <td>${esc(item.hsnSac)}</td>
        <td class="num">${item.quantity ? esc(item.quantity) : "-"}</td>
        <td class="num">${item.rate ? money(item.rate) : "-"}</td>
        <td>${esc(item.unit)}</td>
        <td class="num">${money(item.amount)}</td>
      </tr>`
  ).join("");

  const chargeRows = (v.additionalCharges || [])
    .map((c) => `<tr><td colspan="6"><em>${esc(c.label)}</em></td><td class="num">${money(c.amount)}</td></tr>`)
    .join("");

  const isInterstate = v.igst > 0;
  const taxLineRows = isInterstate
    ? `<tr><td colspan="6"><em>Igst</em></td><td class="num">${money(v.igst)}</td></tr>`
    : `
      <tr><td colspan="6"><em>Cgst</em></td><td class="num">${money(v.cgst)}</td></tr>
      <tr><td colspan="6"><em>Sgst</em></td><td class="num">${money(v.sgst)}</td></tr>`;

  const roundOffRow = buildRoundOffRowHtml(v.roundOff);
  const grandTotal = v.total + v.cgst + v.sgst + v.igst + (v.roundOff || 0);

  return wrap(`
    ${headerHtml(v.company, "Purchase Invoice")}
    <table class="info-table">
      <colgroup>
        <col style="width:16%"><col style="width:12%">
        <col style="width:8%"><col style="width:14%">
        <col style="width:16%"><col style="width:34%">
      </colgroup>
      <tr>
        <td class="label">Invoice Voucher No :</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
        <td class="label">Supplier Invoice No :</td><td>${esc(v.supplierInvoiceNo)}</td>
      </tr>
    </table>
    <div class="party-block">
      <div class="half">
        <div><strong>Supplier</strong></div>
        <div class="name">${esc(v.supplierOrBuyerName)}</div>
        <div>${esc(v.supplierOrBuyerAddress)}</div>
        <div>GSTIN/UIN: ${esc(v.gstin)}</div>
        <div>State: ${esc(v.company.state)}, Code: 27</div>
        <div>Place of Supply: ${esc(v.placeOfSupply)}</div>
      </div>
    </div>
    <table class="data-table">
      <tr>
        <th>Sl</th><th>Description of Goods</th><th>HSN/SAC</th>
        <th class="num">Quantity</th><th class="num">Rate</th><th>per</th><th class="num">Amount</th>
      </tr>
      ${itemRows}
      ${chargeRows}
      ${taxLineRows}
      ${roundOffRow}
      <tr class="total-row">
        <td colspan="6">Total</td><td class="num">Rs. ${money(grandTotal)}</td>
      </tr>
    </table>
    <div class="words-row">
      <div>Amount Chargeable (in words)</div>
      <div>E. &amp; O.E</div>
    </div>
    <div class="amount-words">${esc(amountToWords(grandTotal))}</div>
    ${buildTaxTableHtml(v)}
    <div class="amount-words">Tax Amount (in words) : ${esc(taxAmountWordsFor(v))}</div>
    ${signatureHtml(v.company)}
    ${invoiceFooterHtml(v.company)}
  `);
}

function buildSalesHtml(v) {
  const itemRows = v.items.map(
    (item, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${esc(item.stockItemName)}</strong></td>
        <td>${esc(item.hsnSac)}</td>
        <td class="num">${item.quantity ? esc(item.quantity) : "-"}</td>
        <td class="num">${item.rate ? money(item.rate) : "-"}</td>
        <td>${esc(item.unit)}</td>
        <td class="num">${money(item.amount)}</td>
      </tr>`
  ).join("");

  const chargeRows = (v.additionalCharges || [])
    .map((c) => `<tr><td colspan="6"><em>${esc(c.label)}</em></td><td class="num">${money(c.amount)}</td></tr>`)
    .join("");

  const isInterstate = v.igst > 0;
  const taxLineRows = isInterstate
    ? `<tr><td colspan="6"><em>Igst</em></td><td class="num">${money(v.igst)}</td></tr>`
    : `
      <tr><td colspan="6"><em>Cgst</em></td><td class="num">${money(v.cgst)}</td></tr>
      <tr><td colspan="6"><em>Sgst</em></td><td class="num">${money(v.sgst)}</td></tr>`;

  const roundOffRow = buildRoundOffRowHtml(v.roundOff);
  const grandTotal = v.total + v.cgst + v.sgst + v.igst + (v.roundOff || 0);

  return wrap(`
    ${headerHtml(v.company, "Tax Invoice")}
    <table class="info-table">
      <colgroup>
        <col style="width:16%"><col style="width:12%">
        <col style="width:8%"><col style="width:14%">
        <col style="width:16%"><col style="width:34%">
      </colgroup>
      <tr>
        <td class="label">Invoice Voucher No :</td><td>${esc(v.voucherNumber)}</td>
        <td class="label">Date :</td><td>${esc(v.date)}</td>
        <td class="label">Buyer's Order No :</td><td>${esc(v.buyerOrderNo)}</td>
      </tr>
    </table>
    <div class="party-block">
      <div class="half">
        <div><strong>Consignee (Ship to)</strong></div>
        <div class="name">${esc(v.supplierOrBuyerName)}</div>
        <div>${esc(v.supplierOrBuyerAddress)}</div>
        <div>State: ${esc(v.company.state)}, Code: 27</div>
        <div>Place of Supply: ${esc(v.placeOfSupply)}</div>
      </div>
      <div class="half">
        <div><strong>Buyer (Bill to)</strong></div>
        <div class="name">${esc(v.supplierOrBuyerName)}</div>
        <div>${esc(v.supplierOrBuyerAddress)}</div>
        <div>State: ${esc(v.company.state)}, Code: 27</div>
        <div>Place of Supply: ${esc(v.placeOfSupply)}</div>
      </div>
    </div>
    <table class="data-table">
      <tr>
        <th>Sl</th><th>Description of Goods</th><th>HSN/SAC</th>
        <th class="num">Quantity</th><th class="num">Rate</th><th>per</th><th class="num">Amount</th>
      </tr>
      ${itemRows}
      ${chargeRows}
      ${taxLineRows}
      ${roundOffRow}
      <tr class="total-row">
        <td colspan="6">Total</td><td class="num">Rs. ${money(grandTotal)}</td>
      </tr>
    </table>
    <div class="words-row">
      <div>Amount Chargeable (in words)</div>
      <div>E. &amp; O.E</div>
    </div>
    <div class="amount-words">${esc(amountToWords(grandTotal))}</div>
    ${buildTaxTableHtml(v)}
    <div class="amount-words">Tax Amount (in words) : ${esc(taxAmountWordsFor(v))}</div>
    ${signatureHtml(v.company)}
    ${invoiceFooterHtml(v.company)}
  `);
}

// ---------- dispatch ----------

const TEMPLATE_BUILDERS = {
  contra: buildContraHtml,
  journal: buildJournalHtml,
  payment: buildPaymentHtml,
  receipt: buildReceiptHtml,
  purchase: buildPurchaseHtml,
  sales: buildSalesHtml,
};

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

/**
 * Renders a normalized voucher object (from voucherPdf.service.js's
 * normalizeVoucherRow, with `company` attached from companyInfo.service.js)
 * to a PDF Buffer.
 */
export async function renderVoucherPdf(voucher) {
  const builder = TEMPLATE_BUILDERS[voucher.templateKey];
  if (!builder) {
    throw new Error(
      `No PDF template for voucher type "${voucher.voucherType}" (templateKey: ${voucher.templateKey}). ` +
        `Supported types: ${Object.keys(TEMPLATE_BUILDERS).join(", ")}`
    );
  }

  const html = builder(voucher);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });
  } finally {
    await page.close();
  }
}