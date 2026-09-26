/**
 * src/services/quotation-pdf.service.js
 *
 * Renders a single quotation (fetched via getQuotationById) into a printable
 * PDF buffer using Puppeteer (HTML -> PDF).
 *
 * Header layout: company details on the left; Quotation No / Date / Valid
 * Until stacked on the right — same simple label/value row style used in
 * challan-pdf.service.js (not a grid layout).
 *
 * company_name / company_address / company_email / company_gstin /
 * company_state are expected to be sourced fresh from app_test.company_details
 * (see challan.service.js#getChallanById for the pattern) rather than the
 * snapshot columns on the quotations row. Update quotation.service.js's
 * getQuotationById to join/fetch company_details the same way before calling
 * generateQuotationPdf().
 */

import puppeteer from "puppeteer";

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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function money(n) {
  const num = Number(n) || 0;

  return `Rs. ${num.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatQty(n) {
  const num = Number(n) || 0;

  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function formatDate(d) {
  if (!d) return "";

  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function esc(str) {
  if (str === undefined || str === null) return "";

  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseGstRate(value) {
  const n = parseFloat(String(value ?? "").replace("%", ""));

  return Number.isFinite(n) ? n : 0;
}

function lineAmounts(item) {
  const qty = Number(item.qty) || 0;
  const rate = Number(item.rate) || 0;
  const discountPercent = Number(item.discount_percent) || 0;
  const gstPercent = parseGstRate(item.gst_rate);

  const gross = qty * rate;
  const discount = gross * (discountPercent / 100);
  const taxable = gross - discount;
  const gstAmount = taxable * (gstPercent / 100);
  const lineTotal = taxable + gstAmount;

  return {
    qty,
    rate,
    discountPercent,
    gstPercent,
    gross,
    discount,
    taxable,
    gstAmount,
    lineTotal,
  };
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────

const STYLE = `
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }

  body {
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #1f2937;
    font-size: 12.5px;
    padding: 6px;
  }

  .page {
    border: 1.5px solid #000;
    min-height: 100%;
  }

  /* =========================================================
     TITLE
     ========================================================= */

  .doc-title-bar {
    text-align: center;
    font-weight: bold;
    font-size: 15px;
    padding: 8px 0;
    border-bottom: 2px solid #1a5fb4;
    background: #fff;
    color: #1a5fb4;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
  }

  .revision-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    color: #92400e;
    background: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 4px;
    padding: 2px 7px;
    letter-spacing: 0.03em;
  }

  /* =========================================================
     HEADER  (matches challan-pdf.service.js)
     ========================================================= */

  .header-main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 12px;
    border-bottom: 1px solid #000;
  }

  .company-block { flex: 1 1 auto; min-width: 0; }

  .company-name {
    font-size: 17px;
    font-weight: bold;
    color: #1a5fb4;
    margin: 0 0 3px 0;
    line-height: 1.25;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .company-meta {
    font-size: 10.5px;
    line-height: 1.5;
    color: #333;
  }

  .company-meta strong { color: #111; }

  .header-right { flex: 0 0 auto; text-align: right; white-space: nowrap; }
.doc-meta-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
}

.doc-meta-line {
  display: grid;
  grid-template-columns: 72px 8px auto;
  align-items: center;
  line-height: 1.3;
}

.doc-meta-line .label-text {
  font-weight: bold;
  color: #333;
  text-align: left;
  white-space: nowrap;
}

.doc-meta-line .colon {
  font-weight: bold;
  color: #333;
  text-align: center;
}

.doc-meta-row .value {
  color: #111;
  text-align: left;
  white-space: nowrap;
}
  /* =========================================================
     BILL TO
     ========================================================= */

  .party-block {
    border-bottom: 1px solid #000;
    padding: 7px 8px;
  }

  .party-block .section-label {
    font-size: 10px;
    text-transform: uppercase;
    color: #6b7280;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }

  .party-block .name {
    font-weight: bold;
    font-size: 12px;
  }

  .party-block .muted-line {
    color: #4b5563;
    font-size: 11px;
    margin-top: 1px;
  }

  /* =========================================================
     ITEMS
     ========================================================= */

  table.items {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  table.items th,
  table.items td {
    border: 1px solid #000;
    padding: 5px 7px;
    word-break: break-word;
    overflow-wrap: break-word;
  }

  table.items th {
    background: #f4f6f9;
    text-align: left;
    font-weight: bold;
    color: #111;
    font-size: 10.5px;
  }

  table.items td {
    font-size: 11px;
    vertical-align: top;
  }

  table.items td.num,
  table.items th.num {
    text-align: right;
  }

  .item-name { font-weight: 600; }

  .item-sub {
    font-size: 9.5px;
    color: #6b7280;
    margin-top: 1px;
  }

  /* =========================================================
     TOTALS
     ========================================================= */

  table.totals-table {
    width: 100%;
    border-collapse: collapse;
  }

  table.totals-table td {
    padding: 4px 8px;
    font-size: 11.5px;
    border-top: 1px solid #000;
  }

  table.totals-table td.label { color: #333; }
  table.totals-table td.value { text-align: right; }

  table.totals-table tr.grand-row td {
    font-weight: bold;
    font-size: 13px;
    background: #f4f6f9;
    border-top: 2px solid #000;
  }

  /* =========================================================
     NARRATION
     ========================================================= */

  .narration-block {
    border-top: 1px solid #000;
    padding: 6px 8px;
    font-size: 11px;
    line-height: 1.4;
  }

  .narration-block strong { color: #333; }

  /* =========================================================
     SIGNATURE
     ========================================================= */

  .signature-block {
    display: flex;
    border-top: 1px solid #000;
    min-height: 95px;
  }

  .signature-left {
    flex: 1;
    padding: 8px 10px;
    border-right: 1px solid #000;
    display: flex;
    align-items: flex-end;
  }

  .signature-right {
    flex: 1;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    text-align: right;
  }

  .signature-right .for-company { white-space: nowrap; font-size: 10.5px; }
  .signature-right .auth-label { font-size: 12px; }

  /* =========================================================
     FOOTER
     ========================================================= */

  .footer-divider { border-top: 2px solid #000; }

  .footer {
    text-align: center;
    padding: 5px 0;
    font-size: 10px;
    color: #555;
  }
</style>
`;

// ─────────────────────────────────────────────────────────────
// Item Rows
// ─────────────────────────────────────────────────────────────

function buildItemRows(items = [], gstEnabled = true) {
  return items
    .map((it, idx) => {
      const amt = lineAmounts(it);

      return `
        <tr>
          <td>${idx + 1}</td>
          <td>
            <div class="item-name">${esc(it.item_name)}</div>
            ${
              it.godown_name
                ? `<div class="item-sub">Godown: ${esc(it.godown_name)}</div>`
                : ""
            }
            ${
              it.bin
                ? `<div class="item-sub">Bin: ${esc(it.bin)}</div>`
                : ""
            }
          </td>
          <td>${esc(it.hsn_code || "-")}</td>
          <td class="num">${formatQty(amt.qty)}</td>
          <td>${esc(it.unit || "-")}</td>
          <td class="num">${amt.rate.toFixed(2)}</td>
          <td class="num">
            ${
              amt.discountPercent > 0
                ? amt.discountPercent.toFixed(2).replace(/\.00$/, "") + "%"
                : "-"
            }
          </td>
          ${
            gstEnabled
              ? `<td class="num">${it.gst_rate ? esc(it.gst_rate) : "-"}</td>`
              : ""
          }
          <td class="num">${amt.lineTotal.toFixed(2)}</td>
        </tr>
      `;
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────

function buildHtml(quotation) {
  const {
    quotation_number,
    quotation_date,
    valid_until,

    company_name,
    company_address,
    company_email,
    company_gstin,
    company_state,

    customer_name,
    customer_gstin,
    customer_address,

    supply_type,
    terms_conditions,

    items = [],
  } = quotation;

  const gstEnabled = quotation.gst_enabled ?? true;

  const versionSeq = Number(quotation.version_seq) || 0;
  const isRevision = versionSeq > 0;

  const baseNumber = String(quotation_number || "").split(".")[0];

  // ----------------------------------------------------------
  // Calculate totals from items
  // ----------------------------------------------------------

  let subTotal = 0;
  let totalDiscount = 0;

  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  let grandTotal = 0;

  items.forEach((item) => {
    const amt = lineAmounts(item);

    subTotal += amt.gross;
    totalDiscount += amt.discount;

    if (gstEnabled) {
      if (supply_type === "interstate") {
        totalIgst += amt.gstAmount;
      } else {
        totalCgst += amt.gstAmount / 2;
        totalSgst += amt.gstAmount / 2;
      }
    }

    grandTotal += amt.lineTotal;
  });

  const isInterstate = supply_type === "interstate";

  // ----------------------------------------------------------
  // HTML
  // ----------------------------------------------------------

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  ${STYLE}
</head>
<body>
<div class="page">

  <!-- =====================================================
       TITLE
       ===================================================== -->

  <div class="doc-title-bar">
    QUOTATION
    ${
      isRevision
        ? `
          <span class="revision-badge">
            REVISION ${String(versionSeq).padStart(2, "0")}
            · OF ${esc(baseNumber)}
          </span>
        `
        : ""
    }
  </div>

  <!-- =====================================================
       COMPANY HEADER
       (company_* fields should come from a fresh company_details
       lookup in quotation.service.js#getQuotationById, same as
       challan.service.js#getChallanById does)
       ===================================================== -->

  <div class="header-main">
    <div class="company-block">
      <div class="company-name">${esc(company_name || "")}</div>
      <div class="company-meta">
        ${esc(company_address || "")}
        ${company_email ? `<br/>Email: ${esc(company_email)}` : ""}
        ${
          company_gstin
            ? `<br/>GSTIN: <strong>${esc(company_gstin)}</strong>`
            : ""
        }
        ${company_state ? ` | State: ${esc(company_state)}` : ""}
      </div>
    </div>

    <!-- RIGHT SIDE -->
    <div class="header-right">
    <div class="doc-meta-row">

  <div class="doc-meta-line">
    <span class="label-text">Quotation No</span>
    <span class="colon">:</span>
    <span class="value">${esc(quotation_number || "-")}</span>
  </div>

  <div class="doc-meta-line">
    <span class="label-text">Date</span>
    <span class="colon">:</span>
    <span class="value">${formatDate(quotation_date)}</span>
  </div>

  ${
    valid_until
      ? `
        <div class="doc-meta-line">
          <span class="label-text">Valid Until</span>
          <span class="colon">:</span>
          <span class="value">${formatDate(valid_until)}</span>
        </div>
      `
      : ""
  }

</div>
    </div>
  </div>

  <!-- =====================================================
       CUSTOMER
       ===================================================== -->

  <div class="party-block">
    <div class="section-label">Bill To</div>
    <div class="name">${esc(customer_name || "-")}</div>
    ${
      customer_address
        ? `<div class="muted-line">${esc(customer_address)}</div>`
        : ""
    }
    ${
      customer_gstin
        ? `<div class="muted-line">GSTIN: ${esc(customer_gstin)}</div>`
        : ""
    }
  </div>

  <!-- =====================================================
       ITEMS
       ===================================================== -->

  <table class="items">
    <colgroup>
      <col style="width:5%">
      <col style="width:24%">
      <col style="width:10%">
      <col style="width:8%">
      <col style="width:8%">
      <col style="width:11%">
      <col style="width:9%">
      ${gstEnabled ? `<col style="width:9%">` : ""}
      <col style="width:${gstEnabled ? "16%" : "25%"}">
    </colgroup>

    <thead>
      <tr>
        <th>Sl</th>
        <th>Description of Goods</th>
        <th>HSN/SAC</th>
        <th class="num">Quantity</th>
        <th>Unit</th>
        <th class="num">Rate</th>
        <th class="num">Disc %</th>
        ${gstEnabled ? `<th class="num">GST %</th>` : ""}
        <th class="num">Amount</th>
      </tr>
    </thead>

    <tbody>
      ${
        buildItemRows(items, gstEnabled) ||
        `
          <tr>
            <td colspan="${gstEnabled ? 9 : 8}" style="text-align:center;color:#9ca3af;padding:16px;">
              No items
            </td>
          </tr>
        `
      }
    </tbody>
  </table>

  <!-- =====================================================
       TOTALS
       ===================================================== -->

  <table class="totals-table">
    <tr>
      <td class="label">Subtotal</td>
      <td class="value">${money(subTotal)}</td>
    </tr>

    ${
      totalDiscount > 0
        ? `
          <tr>
            <td class="label">Discount</td>
            <td class="value">- ${money(totalDiscount)}</td>
          </tr>
        `
        : ""
    }

    ${
      gstEnabled
        ? !isInterstate
          ? `
            <tr>
              <td class="label">CGST</td>
              <td class="value">${money(totalCgst)}</td>
            </tr>
            <tr>
              <td class="label">SGST</td>
              <td class="value">${money(totalSgst)}</td>
            </tr>
          `
          : `
            <tr>
              <td class="label">IGST</td>
              <td class="value">${money(totalIgst)}</td>
            </tr>
          `
        : ""
    }

    <tr class="grand-row">
      <td>Total Payable</td>
      <td class="value">${money(grandTotal)}</td>
    </tr>
  </table>

  <!-- =====================================================
       TERMS / NARRATION
       ===================================================== -->

  ${
    terms_conditions
      ? `
        <div class="narration-block">
          <strong>Terms & Conditions:</strong>
          ${esc(terms_conditions)}
        </div>
      `
      : ""
  }

  <!-- =====================================================
       SIGNATURE
       ===================================================== -->

  <div class="signature-block">
    <div class="signature-left">
      Receiver's Seal and Signature
    </div>

    <div class="signature-right">
      <div class="for-company">for <strong>${esc(company_name || "")}</strong></div>
      <div class="auth-label">Authorised Signatory</div>
    </div>
  </div>

  <!-- =====================================================
       FOOTER
       ===================================================== -->

  <div class="footer-divider"></div>

  <div class="footer">
    This is a Computer Generated Quotation
    ${isRevision ? ` (Revision ${String(versionSeq).padStart(2, "0")})` : ""}
  </div>

</div>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────────────────────

export async function generateQuotationPdf(quotation) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(buildHtml(quotation), {
      waitUntil: "networkidle0",
    });

    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "10mm",
        bottom: "10mm",
        left: "10mm",
        right: "10mm",
      },
    });
  } finally {
    await page.close();
  }
}