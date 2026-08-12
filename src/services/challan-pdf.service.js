/**
 * src/services/challan-pdf.service.js
 *
 * Renders a single challan (fetched via getChallanById) into a printable
 * PDF buffer using Puppeteer (HTML -> PDF).
 *
 * Header layout: company details on the left; Challan No / Date and
 * Delivery Person details stacked on the right (challan no/date on top,
 * delivery person below it).
 *
 * GST columns/rows (GST %, CGST, SGST, IGST) are shown only when
 * challan.gst_enabled is true.
 *
 * company_name / company_address / company_email / company_gstin /
 * company_state are expected to be sourced fresh from app_test.company_details
 * (see challan.service.js#getChallanById) rather than the snapshot columns
 * on the challans row.
 */

import puppeteer from "puppeteer";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function money(n) {
  const num = Number(n) || 0;
  return `Rs. ${num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseGstRate(gstRateField) {
  const n = parseFloat(String(gstRateField).replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function lineAmounts(item) {
  const qty     = Number(item.qty) || 0;
  const rate    = Number(item.rate) || 0;
  const discPct = Number(item.discount_percent) || 0;
  const gstPct  = parseGstRate(item.gst_rate);

  const gross     = qty * rate;
  const discount  = gross * (discPct / 100);
  const taxable   = gross - discount;
  const gstAmount = taxable * (gstPct / 100);
  const lineTotal = taxable + gstAmount;

  return { qty, rate, discPct, gstPct, gross, discount, taxable, gstAmount, lineTotal };
}

function esc(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatQty(n) {
  const num = Number(n) || 0;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function formatMovementType(movementType) {
  if (!movementType) return "";
  return movementType.charAt(0).toUpperCase() + movementType.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────
// HTML template
// ─────────────────────────────────────────────────────────────────────────

const STYLE = `
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1f2937;
    font-size: 12.5px;
  }

  
  .page-content { flex: 1 0 auto; }

  /* ---- header: company (left) + challan no/date + delivery person (right) ---- */
  .header-main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 12px;
    border-bottom: 1px solid #000;
  }
  .company-block { flex: 1 1 auto; min-width: 0; }
  .company-name { font-size: 17px; font-weight: bold; color: #1a5fb4; margin: 0 0 3px 0; line-height: 1.25; }
  .company-meta { font-size: 10.5px; line-height: 1.5; color: #333; }
  .company-meta strong { color: #111; }

  .header-right { flex: 0 0 auto; text-align: right; white-space: nowrap; }
  .doc-meta-row { font-size: 11.5px; margin-bottom: 8px; }
  .doc-meta-row .label { font-weight: bold; color: #333; }
  .doc-meta-row .value { color: #111; }

  .delivery-block { font-size: 11px; text-align: right; }
  .delivery-block .section-label {
    font-size: 10px; text-transform: uppercase; color: #6b7280;
    letter-spacing: 0.04em; margin-bottom: 2px;
  }
  .delivery-block .name { font-weight: bold; }
  .delivery-block .muted-line { color: #4b5563; margin-top: 1px; }

  /* ---- title bar ---- */
 .doc-title-bar {
    text-align: center; font-weight: bold; font-size: 14px; padding: 8px 0;
    border-bottom: 2px solid #1a5fb4; background: #fff; color: #1a5fb4;
    display: flex; justify-content: center; align-items: center; gap: 10px;
  }
  .movement-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    color: #374151; background: #eef2f8; border-radius: 4px;
    padding: 2px 7px; letter-spacing: 0.04em;
  }

  /* ---- bill-to block ---- */
  .party-block { border-bottom: 1px solid #000; padding: 6px 8px; }
  .party-block .section-label { font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.04em; margin-bottom: 2px; }
  .party-block .name { font-weight: bold; }
  .party-block .muted-line { color: #4b5563; font-size: 11px; margin-top: 1px; }

  /* ---- items table: full grid ---- */
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.items th, table.items td {
    border: 1px solid #000; padding: 5px 8px; word-break: break-word; overflow-wrap: break-word;
  }
  table.items th { background: #f4f6f9; text-align: left; font-weight: bold; color: #111; font-size: 11px; }
  table.items td { font-size: 11.5px; vertical-align: top; }
  table.items td.num, table.items th.num { text-align: right; }
  .item-name { font-weight: 600; }
  .item-sub { font-size: 10px; color: #9ca3af; margin-top: 1px; }

  /* ---- totals ---- */
  table.totals-table { width: 100%; border-collapse: collapse; }
  table.totals-table td { padding: 4px 8px; font-size: 11.5px; border-top: 1px solid #000; }
  table.totals-table td.label { color: #333; }
  table.totals-table td.value { text-align: right; }
  table.totals-table tr.grand-row td { font-weight: bold; font-size: 13px; background: #f4f6f9; }

  .narration-block { border-top: 1px solid #000; padding: 6px 8px; font-size: 11px; }
  .narration-block strong { color: #333; }

  table.totals-table tr.grand-row td { font-weight: bold; font-size: 13px; background: #f4f6f9; border-top: 2px solid #000; }

/* ---- signature block ---- */
  .signature-block { display: flex; border-top: 1px solid #000; min-height: 95px; }
  .signature-left {
    flex: 1; padding: 8px 10px; border-right: 1px solid #000;
    display: flex; align-items: flex-end;
  }
  .signature-right {
    flex: 1; padding: 8px 10px;
    display: flex; flex-direction: column; justify-content: space-between;
    align-items: flex-end; text-align: right;
  }
  .signature-right .for-company { white-space: nowrap; font-size: 10.5px; }
  .signature-right .auth-label { font-size: 12px; }

  .footer-divider { border-top: 1px solid #000; }
  .footer { text-align: center; padding: 5px 0; font-size: 10px; color: #555; }
  /* bold closing rule, same weight as the Total Payable row above */
  .footer-divider { border-top: 2px solid #000; }
  .footer { text-align: center; padding: 5px 0; font-size: 10px; color: #555; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1f2937;
    font-size: 12.5px;
    padding: 6px;
  }

  .page {
    box-sizing: border-box;
    border: 1.5px solid #000;
  }
</style>`;

function buildItemRows(items = [], gstEnabled = true) {
  return items
    .map((it, idx) => {
      const amt = lineAmounts(it);
      return `
      <tr>
        <td>${idx + 1}</td>
        <td>
          <div class="item-name">${esc(it.item_name)}</div>
          ${it.godown_name ? `<div class="item-sub">Godown: ${esc(it.godown_name)}</div>` : ""}
          ${it.bin ? `<div class="item-sub">Bin: ${esc(it.bin)}</div>` : ""}
        </td>
        <td>${esc(it.hsn_code || "-")}</td>
        <td class="num">${formatQty(amt.qty)}</td>
        <td class="num">${amt.rate.toFixed(2)}</td>
        <td class="num">${amt.discPct > 0 ? amt.discPct.toFixed(2).replace(/\.00$/, "") + "%" : "-"}</td>
        ${gstEnabled ? `<td class="num">${it.gst_rate ? esc(it.gst_rate) : "-"}</td>` : ""}
        <td class="num">${amt.lineTotal.toFixed(2)}</td>
      </tr>`;
    })
    .join("");
}

function buildHtml(challan) {
  const {
    challan_number,
    challan_date,
    company_name,
    company_address,
    company_email,
    company_gstin,
    company_state,
    customer_name,
    customer_address,
    customer_gstin,
    supply_type,
    narration,
    challan_type,
    movement_type,
    delivery_person,
    items = [],
  } = challan;

  const gstEnabled = challan.gst_enabled ?? true;
  const docTitle    = (challan_type || "Delivery Challan").toUpperCase();
  const movementTag = formatMovementType(movement_type);

  let subTotal = 0, totalDiscount = 0, totalGst = 0, grandTotal = 0;
  items.forEach((it) => {
    const amt = lineAmounts(it);
    subTotal      += amt.gross;
    totalDiscount += amt.discount;
    totalGst      += amt.gstAmount;
    grandTotal    += amt.lineTotal;
  });

  const isInterstate = supply_type === "interstate";

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    ${STYLE}
  </head>
  <body>
  <div class="page">
    <div class="page-content">

      <div class="doc-title-bar">
        ${esc(docTitle)}
        ${movementTag ? `<span class="movement-badge">${esc(movementTag)}</span>` : ""}
      </div>

      <div class="header-main">
        <div class="company-block">
          <div class="company-name">${esc(company_name || "")}</div>
          <div class="company-meta">
            ${esc(company_address || "")}<br/>
            ${company_email ? `Email: ${esc(company_email)}<br/>` : ""}
            GSTIN: <strong>${esc(company_gstin || "")}</strong> | State: ${esc(company_state || "")}
          </div>
        </div>
        <div class="header-right">
          <div class="doc-meta-row">
            <div><span class="label">Challan No : </span><span class="value">${esc(challan_number || "-")}</span></div>
            <div><span class="label">Date : </span><span class="value">${formatDate(challan_date)}</span></div>
          </div>
          ${delivery_person ? `
<div class="delivery-block">
  <div class="section-label">Delivery Person</div>
  <div class="name">${esc(delivery_person.name)}</div>
  ${delivery_person.phone_number ? `<div class="muted-line">${esc(delivery_person.phone_number)}</div>` : ""}
</div>` : ""}
        </div>
      </div>

      <div class="party-block">
        <div class="section-label">Bill To</div>
        <div class="name">${esc(customer_name || "-")}</div>
        ${customer_address ? `<div class="muted-line">${esc(customer_address)}</div>` : ""}
        ${customer_gstin ? `<div class="muted-line">GSTIN: ${esc(customer_gstin)}</div>` : ""}
      </div>

     

      <table class="items">
        <colgroup>
          <col style="width:5%"><col style="width:28%"><col style="width:10%">
          <col style="width:9%"><col style="width:11%"><col style="width:9%">
          ${gstEnabled ? '<col style="width:9%">' : ""}
          <col style="width:${gstEnabled ? "19%" : "28%"}">
        </colgroup>
        <thead>
          <tr>
            <th>Sl</th><th>Description of Goods</th><th>HSN/SAC</th>
            <th class="num">Quantity</th><th class="num">Rate</th><th class="num">Disc %</th>
            ${gstEnabled ? '<th class="num">GST %</th>' : ""}
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>${buildItemRows(items, gstEnabled) || `<tr><td colspan="${gstEnabled ? 8 : 7}" style="text-align:center;color:#9ca3af;padding:16px;">No items</td></tr>`}</tbody>
      </table>

      <table class="totals-table">
        <tr><td class="label">Subtotal</td><td class="value">${money(subTotal)}</td></tr>
        ${totalDiscount > 0 ? `<tr><td class="label">Discount</td><td class="value">- ${money(totalDiscount)}</td></tr>` : ""}
        ${gstEnabled ? (
          !isInterstate ? `
          <tr><td class="label">CGST</td><td class="value">${money(totalGst / 2)}</td></tr>
          <tr><td class="label">SGST</td><td class="value">${money(totalGst / 2)}</td></tr>
          ` : `
          <tr><td class="label">IGST</td><td class="value">${money(totalGst)}</td></tr>
          `
        ) : ""}
        <tr class="grand-row"><td>Total</td><td class="value">${money(grandTotal)}</td></tr>
      </table>

      ${narration ? `<div class="narration-block"><strong>Narration:</strong> ${esc(narration)}</div>` : ""}

 <div class="signature-block">
        <div class="signature-left">Receiver's Seal and Signature</div>
        <div class="signature-right">
          <div class="for-company">for <strong>${esc(company_name || "")}</strong></div>
          <div class="auth-label">Authorised Signatory</div>
        </div>
      </div>

      <div class="footer-divider"></div>
      <div class="footer">This is a Computer Generated ${esc(docTitle.charAt(0) + docTitle.slice(1).toLowerCase())}</div>

    </div>
  </div>

  </div>
  </body>
  </html>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────

export async function buildChallanPdf(challan) {
  const html = buildHtml(challan);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}