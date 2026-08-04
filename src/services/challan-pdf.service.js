/**
 * src/services/challan-pdf.service.js
 *
 * Renders a single challan (fetched via getChallanById) into a printable
 * PDF buffer using Puppeteer (HTML -> PDF). No new dependency needed —
 * this uses the puppeteer you already have installed.
 *
 * Usage (see src/api/challanpdf.routes.js):
 *   const pdfBuffer = await buildChallanPdf(challan);
 *   res.setHeader("Content-Type", "application/pdf");
 *   res.send(pdfBuffer);
 *
 * Note on Puppeteer + nodemon/dev servers:
 *   Puppeteer launches a headless Chromium process per call. For a
 *   low/medium traffic internal tool that's fine as-is. If you start
 *   generating a lot of PDFs, switch to a single shared browser instance
 *   (launch once at server startup, reuse `browser.newPage()` per request,
 *   close on process exit) instead of launch/close every call.
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

// ─────────────────────────────────────────────────────────────────────────
// HTML template — mirrors quotation-pdf.service.js's header/layout exactly
// so the two documents look like a matched set.
// ─────────────────────────────────────────────────────────────────────────

function buildItemRows(items = []) {
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
        <td class="num">${it.gst_rate ? esc(it.gst_rate) : "-"}</td>
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
    company_gstin,
    customer_name,
    customer_address,
    customer_gstin,
    supply_type,
    narration,
    status,
    items = [],
  } = challan;

  let subTotal = 0, totalDiscount = 0, totalGst = 0, grandTotal = 0;
  items.forEach((it) => {
    const amt = lineAmounts(it);
    subTotal      += amt.gross;
    totalDiscount += amt.discount;
    totalGst      += amt.gstAmount;
    grandTotal    += amt.lineTotal;
  });

  const isInterstate = supply_type === "interstate";
  const supplyTypeLabel = isInterstate ? "Interstate (IGST)" : "Intrastate (CGST + SGST)";

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        font-family: 'Helvetica Neue', Arial, sans-serif;
        color: #1f2937;
        font-size: 13px;
      }

      /* ---------- Page frame ----------
         Border is now the outer boundary of the whole printable page (the
         physical margin from the paper edge is handled by the margin
         option in page.pdf() itself), not just a box around the content. */
      .page {
  box-sizing: border-box;
  min-height: 100vh;
  border: 1.5px solid #374151;
  border-radius: 6px;
  padding: 40px 30px 24px 30px;
}

      /* ---------- Header ---------- */
      .header-top { text-align: right; margin-bottom: 2px; }
      .doc-title { font-size: 18px; font-weight: 700; color: #2563eb; letter-spacing: 0.03em; }

      .header-main {
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }

      .company-block {
        flex: 1 1 auto;
        min-width: 0;
      }

      .company-name {
        font-size: 19px;
        font-weight: 700;
        color: #111827;
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .muted-line { color: #9ca3af; font-size: 11.5px; margin-top: 3px; }

      .header-right { flex: 0 0 auto; text-align: right; white-space: nowrap; }
      .doc-meta { font-size: 12px; }
      .doc-meta .label { font-weight: 700; color: #1f2937; }
      .doc-meta .value { color: #4b5563; margin-top: 2px; }

      .divider { border-bottom: 1px solid #e5e7eb; margin: 20px 0; }

      /* ---------- Bill To ---------- */
      .section-label {
        font-size: 11px; text-transform: uppercase; color: #9ca3af;
        letter-spacing: 0.05em; margin-bottom: 4px;
      }
      .bill-to-name { font-size: 14px; font-weight: 700; color: #111827; margin-bottom: 3px; }
      .bill-to .section-label { color: #6b7280; }
      .bill-to .muted-line { margin-top: 2px; color: #4b5563; }

      /* ---------- Table ---------- */
      table.items { width: 100%; border-collapse: collapse; margin: 22px 0 18px; }
      table.items th {
        background: #eef2f8; color: #374151; text-align: left;
        padding: 9px 8px; font-size: 11px; font-weight: 700;
        border-bottom: 1px solid #e2e6ee;
      }
      table.items td {
        padding: 9px 8px; border-bottom: 1px solid #f0f1f4; font-size: 12px; vertical-align: top;
      }
      table.items td.num, table.items th.num { text-align: right; }
      .item-name { font-weight: 600; color: #1f2937; }
      .item-sub { font-size: 10.5px; color: #9ca3af; margin-top: 1px; }

      /* ---------- Totals ---------- */
      .totals { width: 300px; margin-left: auto; }
      .totals table { width: 100%; border-collapse: collapse; }
      .totals td { padding: 5px 4px; font-size: 12.5px; }
      .totals .label { color: #6b7280; }
      .totals .value { text-align: right; color: #1f2937; }
      .totals .grand-row td {
        font-weight: 700; font-size: 15px; padding-top: 10px; padding-bottom: 10px;
        background: #eff6ff; color: #2563eb;
      }
      .totals .grand-row td:first-child { border-radius: 4px 0 0 4px; padding-left: 10px; }
      .totals .grand-row td:last-child { border-radius: 0 4px 4px 0; padding-right: 10px; }

      /* ---------- Narration / Terms ---------- */
      .narration { margin-top: 8px; }
      .narration p { margin: 4px 0 0; color: #374151; font-size: 12px; }

      /* ---------- Footer ---------- */
      .footer-divider { border-bottom: 1px solid #e5e7eb; margin: 28px 0 12px; }
      .footer { display: flex; justify-content: space-between; font-size: 11px; color: #9ca3af; }
    </style>
  </head>
  <body>
  <div class="page">

    <div class="header-top">
      <div class="doc-title">DELIVERY CHALLAN</div>
    </div>

    <div class="header-main">
      <div class="company-block">
        <div class="company-name">${esc(company_name || "")}</div>
        ${company_address ? `<div class="muted-line">${esc(company_address)}</div>` : ""}
        ${company_gstin ? `<div class="muted-line">GSTIN: ${esc(company_gstin)}</div>` : ""}
      </div>
      <div class="header-right">
        <div class="doc-meta">
          <div class="label">Challan No: ${esc(challan_number || "-")}</div>
          <div class="value">Date: ${formatDate(challan_date)}</div>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="bill-to">
      <div class="section-label">Bill To</div>
      <div class="bill-to-name">${esc(customer_name || "-")}</div>
      ${customer_address ? `<div class="muted-line">${esc(customer_address)}</div>` : ""}
      ${customer_gstin ? `<div class="muted-line">GSTIN: ${esc(customer_gstin)}</div>` : ""}
      <div class="muted-line">Supply Type: ${supplyTypeLabel}</div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>#</th><th>Item</th><th>HSN</th>
          <th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th>
          <th class="num">GST %</th><th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${buildItemRows(items) || `<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">No items</td></tr>`}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td class="label">Subtotal</td><td class="value">${money(subTotal)}</td></tr>
        ${totalDiscount > 0 ? `<tr><td class="label">Discount</td><td class="value">- ${money(totalDiscount)}</td></tr>` : ""}
        ${!isInterstate ? `
        <tr><td class="label">CGST</td><td class="value">${money(totalGst / 2)}</td></tr>
        <tr><td class="label">SGST</td><td class="value">${money(totalGst / 2)}</td></tr>
        ` : `
        <tr><td class="label">IGST</td><td class="value">${money(totalGst)}</td></tr>
        `}
        <tr class="grand-row"><td>Total Payable</td><td class="value">${money(grandTotal)}</td></tr>
      </table>
    </div>

    ${narration ? `
    <div class="narration">
      <div class="section-label">Narration</div>
      <p>${esc(narration)}</p>
    </div>` : ""}

    <div class="footer-divider"></div>
    <div class="footer">
      <div>Status: ${esc((status || "DRAFT").toUpperCase())}</div>
      <div>This is a computer generated challan.</div>
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
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}