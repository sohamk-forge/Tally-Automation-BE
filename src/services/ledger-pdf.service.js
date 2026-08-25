/**
 * src/services/ledger-pdf.service.js
 *
 * Tally-style Ledger Account PDF
 *
 * Modes:
 *   simple
 *   detailed_inventory
 *   detailed_narration
 */

import puppeteer from "puppeteer";

const VALID_MODES = [
  "simple",
  "detailed_inventory",
  "detailed_narration",
];


/* ==========================================================================
   BASIC HELPERS
   ========================================================================== */

function money(value) {
  const number = Number(value) || 0;

  return number.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}


function esc(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return esc(value);
  }

  return date
    .toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    })
    .replace(/ /g, "-");
}


function pick(object, ...keys) {
  for (const key of keys) {
    if (
      object &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return undefined;
}


function asArray(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object") {
    return [value];
  }

  return [];
}


/* ==========================================================================
   NARRATION
   ========================================================================== */

function narrationLines(narration) {
  return String(narration || "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}


/* ==========================================================================
   VOUCHER NORMALIZATION
   ========================================================================== */

function normalizeVoucher(raw) {
  const date = pick(
    raw,
    "voucher_date",
    "date",
    "voucherDate",
    "challan_date"
  );

  const vchType =
    pick(
      raw,
      "voucher_type",
      "vch_type",
      "voucherType",
      "type"
    ) || "-";

  const vchNo =
    pick(
      raw,
      "voucher_number",
      "vch_no",
      "voucherNumber",
      "voucher_no"
    ) || "-";

  const party =
    pick(
      raw,
      "party_ledger_name",
      "party",
      "particulars",
      "partyLedgerName"
    ) || "-";

  const narration =
    pick(
      raw,
      "narration",
      "note",
      "notes"
    ) || "";

  const debit =
    Number(
      pick(raw, "debit", "Debit")
    ) || 0;

  const credit =
    Number(
      pick(raw, "credit", "Credit")
    ) || 0;

  const entriesRaw =
    pick(
      raw,
      "ledger_entries",
      "ledgerEntries",
      "entries",
      "LEDGERENTRIES.LIST"
    ) || [];

  const entries = Array.isArray(entriesRaw)
    ? entriesRaw
    : typeof entriesRaw === "object" && entriesRaw
      ? [entriesRaw]
      : [];

  return {
    date,
    vchType,
    vchNo,
    party,
    narration,
    debit,
    credit,
    entries,
  };
}


/* ==========================================================================
   DR / CR
   ========================================================================== */

function resolveSide(isDeemedPositiveYes, rawAmount) {
  const isNegative = Number(rawAmount) < 0;

  const isDebit =
    isDeemedPositiveYes !== isNegative;

  return isDebit
    ? "debit"
    : "credit";
}


/* ==========================================================================
   INVENTORY FINDER
   ========================================================================== */

function findInventoryAllocations(object, depth = 0) {
  if (
    !object ||
    typeof object !== "object" ||
    depth > 8
  ) {
    return [];
  }

  const inventoryKeys = [
    "INVENTORYALLOCATIONS.LIST",
    "INVENTORYALLOCATIONS",
    "inventoryAllocations",
    "inventory_allocations",
    "STOCKITEMALLOCATIONS.LIST",
    "STOCKITEMALLOCATIONS",
    "stockItemAllocations",
  ];

  for (const key of inventoryKeys) {
    if (object[key]) {
      const items = asArray(object[key]);

      if (items.length) {
        return items;
      }
    }
  }

  /*
   * Object itself is an inventory item.
   */
  if (
    object.STOCKITEMNAME ||
    object.stockItemName ||
    object.stock_item_name
  ) {
    return [object];
  }

  /*
   * Search nested structures.
   */
  for (const value of Object.values(object)) {
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found =
          findInventoryAllocations(
            item,
            depth + 1
          );

        if (found.length) {
          return found;
        }
      }

      continue;
    }

    if (typeof value === "object") {
      const found =
        findInventoryAllocations(
          value,
          depth + 1
        );

      if (found.length) {
        return found;
      }
    }
  }

  return [];
}


/* ==========================================================================
   ENTRY NORMALIZATION
   ========================================================================== */

/*
 * Output rows:
 *
 * group
 *   Sales - Spare Parts
 *
 * item
 *   EICHER MILE MAX DEF 1/20 L    20 nos      1,610.20 Cr
 *
 * ledger
 *   CGST                                      14.92 Cr
 */

function normalizeEntry(entry) {
  const ledgerName =
    pick(
      entry,
      "LEDGERNAME",
      "ledgername",
      "ledgerName",
      "NAME",
      "name"
    ) || "-";

  const rawAmount =
    Number(
      pick(
        entry,
        "AMOUNT",
        "amount"
      )
    ) || 0;

  const isDeemedPositiveYes =
    String(
      pick(
        entry,
        "ISDEEMEDPOSITIVE",
        "isdeemedpositive",
        "isDeemedPositive"
      ) || ""
    )
      .trim()
      .toLowerCase() === "yes";

  const side =
    resolveSide(
      isDeemedPositiveYes,
      rawAmount
    );

  const inventoryItems =
    findInventoryAllocations(entry);


  /*
   * Normal ledger row:
   * CGST / SGST / Round Off etc.
   */
  if (!inventoryItems.length) {
    return [
      {
        kind: "ledger",
        label: ledgerName,
        amount: Math.abs(rawAmount),
        side,
      },
    ];
  }


  /*
   * Inventory ledger group.
   */
  const rows = [
    {
      kind: "group",
      label: ledgerName,
    },
  ];


  inventoryItems.forEach((item) => {
    const stockName =
      pick(
        item,
        "STOCKITEMNAME",
        "stockItemName",
        "stock_item_name",
        "STOCKITEM",
        "stockItem",
        "NAME",
        "name"
      ) || "-";


    const qty =
      pick(
        item,
        "ACTUALQTY",
        "actualQty",
        "BILLEDQTY",
        "billedQty",
        "QTY",
        "qty",
        "QUANTITY",
        "quantity"
      ) || "";


    const itemAmountRaw =
      pick(
        item,
        "AMOUNT",
        "amount"
      );

    const itemAmount =
      Number(itemAmountRaw);

    const amount =
      Number.isFinite(itemAmount) &&
      itemAmountRaw !== undefined &&
      itemAmountRaw !== null &&
      itemAmountRaw !== ""
        ? Math.abs(itemAmount)
        : Math.abs(rawAmount);


    rows.push({
      kind: "item",
      name: stockName,
      qty,
      amount,
      side,
    });
  });


  return rows;
}


/* ==========================================================================
   HEADER
   ========================================================================== */

function buildHeaderHtml({
  company = {},
  ledgerName,
  fromDate,
  toDate,
}) {
  return `
    <div class="letterhead">

      <div class="company-name">
        ${esc(company.name || "Company Name")}
      </div>

      ${
        company.address
          ? `
            <div class="company-detail">
              ${esc(company.address)}
            </div>
          `
          : ""
      }

      ${
        company.email
          ? `
            <div class="company-detail">
              Email : ${esc(company.email)}
            </div>
          `
          : ""
      }

      ${
        company.gstin
          ? `
            <div class="company-detail">
              GSTIN : ${esc(company.gstin)}
            </div>
          `
          : ""
      }

    </div>


    <div class="ledger-title">

      <div class="ledger-name">
        ${esc(ledgerName || "-")}
      </div>

      <div class="ledger-subtitle">
        Ledger Account
      </div>

      <div class="ledger-period">
        ${formatDate(fromDate)}
        to
        ${formatDate(toDate)}
      </div>

    </div>
  `;
}


/* ==========================================================================
   DETAIL ROW HTML
   ========================================================================== */

function detailRowHtml(row) {

  /*
   * Example:
   *
   *       Sales - Spare Parts
   */
  if (row.kind === "group") {
    return `
      <tr class="detail-group-row">

        <td></td>

        <td class="detail-group-name">
          ${esc(row.label)}
        </td>

        <td></td>
        <td></td>
        <td></td>
        <td></td>

      </tr>
    `;
  }


  /*
   * Example:
   *
   *          EICHER MILE MAX DEF 1/20 L
   *                                      20 nos
   *                                                     1,610.20 Cr
   */
  if (row.kind === "item") {
    const suffix =
      row.side === "debit"
        ? "Dr"
        : "Cr";

    return `
      <tr class="detail-item-row">

        <td></td>

        <td class="stock-item-name">
          ${esc(row.name)}
        </td>

        <td class="stock-qty">
          ${esc(row.qty)}
        </td>

        <td></td>

        <td></td>

        <td class="detail-amount">
          ${
            row.amount
              ? `${money(row.amount)} ${suffix}`
              : ""
          }
        </td>

      </tr>
    `;
  }


  /*
   * Example:
   *
   *       CGST                           14.92 Cr
   *       SGST                           14.92 Cr
   *       Round Off                       0.10 Dr
   */

  const suffix =
    row.side === "debit"
      ? "Dr"
      : "Cr";

  return `
    <tr class="detail-ledger-row">

      <td></td>

      <td class="detail-ledger-name">
        ${esc(row.label)}
      </td>

      <td></td>
      <td></td>
      <td></td>

      <td class="detail-amount">
        ${
          row.amount
            ? `${money(row.amount)} ${suffix}`
            : ""
        }
      </td>

    </tr>
  `;
}


/* ==========================================================================
   VOUCHER TABLE ROWS
   ========================================================================== */

function buildTableRows(vouchers, mode) {
  let runningDebit = 0;
  let runningCredit = 0;

  let lastDateKey = null;

  const detailed =
    mode === "detailed_inventory" ||
    mode === "detailed_narration";


  const rowsHtml =
    vouchers
      .map((raw) => {
        const voucher =
          normalizeVoucher(raw);

        runningDebit += voucher.debit;
        runningCredit += voucher.credit;


        /*
         * Safe date key.
         */
        let currentDateKey = "";

        if (voucher.date) {
          const parsedDate =
            new Date(voucher.date);

          currentDateKey =
            Number.isNaN(parsedDate.getTime())
              ? String(voucher.date)
              : parsedDate
                  .toISOString()
                  .slice(0, 10);
        }


        const showDate =
          currentDateKey !== lastDateKey;

        lastDateKey =
          currentDateKey;


        const verb =
          voucher.debit > 0
            ? "To"
            : "By";


        /*
         * Build detailed inventory rows.
         */
        let detailRows = [];

        if (detailed) {
          detailRows =
            voucher.entries
              .flatMap(normalizeEntry)
              .filter((row) => {

                /*
                 * Always keep inventory item.
                 */
                if (row.kind === "item") {
                  return true;
                }

                /*
                 * Always keep inventory group.
                 */
                if (row.kind === "group") {
                  return true;
                }

                /*
                 * Remove duplicate party ledger only.
                 */
                return (
                  String(row.label || "")
                    .trim()
                    .toLowerCase()
                  !==
                  String(voucher.party || "")
                    .trim()
                    .toLowerCase()
                );
              });
        }


        const particularsSuffix =
          detailed && detailRows.length
            ? " (as per details)"
            : "";


        let html = `
          <tbody class="voucher-group">

            <tr class="voucher-row">

              <td class="date-cell">
                ${
                  showDate
                    ? formatDate(voucher.date)
                    : ""
                }
              </td>

              <td class="particulars-cell">
                ${verb}
                <span class="party-name">
                  ${esc(voucher.party)}
                </span>
                ${particularsSuffix}
              </td>

              <td class="voucher-type-cell">
                ${esc(voucher.vchType)}
              </td>

              <td class="voucher-no-cell">
                ${esc(voucher.vchNo)}
              </td>

              <td class="amount-cell">
                ${
                  voucher.debit
                    ? money(voucher.debit)
                    : ""
                }
              </td>

              <td class="amount-cell">
                ${
                  voucher.credit
                    ? money(voucher.credit)
                    : ""
                }
              </td>

            </tr>
        `;


        /*
         * Details.
         */
        detailRows.forEach((row) => {
          html += detailRowHtml(row);
        });


        /*
         * Narration.
         */
        if (
          mode === "detailed_narration" &&
          voucher.narration
        ) {
          narrationLines(
            voucher.narration
          ).forEach((line) => {
            html += `
              <tr class="narration-row">

                <td></td>

                <td
                  colspan="5"
                  class="narration-cell"
                >
                  ${esc(line)}
                </td>

              </tr>
            `;
          });
        }


        html += `
          </tbody>
        `;

        return html;
      })
      .join("");


  return {
    rowsHtml,
    runningDebit,
    runningCredit,
  };
}


/* ==========================================================================
   COMPLETE HTML
   ========================================================================== */

function buildHtml({
  mode,
  company,
  ledgerName,
  fromDate,
  toDate,
  openingBalance,
  vouchers = [],
}) {
  const {
    rowsHtml,
    runningDebit,
    runningCredit,
  } = buildTableRows(
    vouchers,
    mode
  );


  const opening =
    Number(openingBalance) || 0;

  const closing =
    opening +
    runningDebit -
    runningCredit;

  const closingIsDebit =
    closing >= 0;


  const grandDebit =
    runningDebit +
    (opening > 0 ? opening : 0) +
    (
      closingIsDebit
        ? 0
        : Math.abs(closing)
    );

  const grandCredit =
    runningCredit +
    (opening < 0 ? Math.abs(opening) : 0) +
    (
      closingIsDebit
        ? Math.abs(closing)
        : 0
    );


  return `
<!DOCTYPE html>

<html>

<head>

<meta charset="utf-8" />

<style>

  * {
    box-sizing: border-box;
  }


  html,
  body {
    margin: 0;
    padding: 0;
  }


  body {
    font-family:
      Arial,
      Helvetica,
      sans-serif;

    font-size: 9px;

    color: #000;
  }


  /* ================================================================
     PAGE
     ================================================================ */

  .page {

    border: 1px solid #000;

    padding:
      9px
      10px
      6px;

    min-height: 100%;

    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }


  /* ================================================================
     COMPANY HEADER
     ================================================================ */

  .letterhead {

    text-align: center;

    margin-bottom: 5px;
  }


  .company-name {

    font-size: 14px;

    font-weight: 700;

    letter-spacing: 0.2px;

    margin-bottom: 2px;
  }


  .company-detail {

    font-size: 8px;

    line-height: 1.25;

    color: #222;
  }


  /* ================================================================
     LEDGER HEADER
     ================================================================ */

  .ledger-title {

    text-align: center;

    margin-top: 7px;

    margin-bottom: 10px;
  }


  .ledger-name {

    font-size: 11px;

    font-weight: 700;

    margin-bottom: 2px;
  }


  .ledger-subtitle {

    font-size: 8.5px;

    line-height: 1.2;
  }


  .ledger-period {

    font-size: 8px;

    margin-top: 2px;
  }


  /* ================================================================
     TABLE
     NO TABLE OUTER BORDER
     ================================================================ */

  table {

    width: 100%;

    border-collapse: collapse;

    table-layout: fixed;

    border: none;
  }


  /*
   * Column proportions tuned for screenshot:
   *
   * Date | Particulars | Type | No | Debit | Credit
   */

  .col-date {
    width: 62px;
  }

  .col-type {
    width: 58px;
  }

  .col-no {
    width: 50px;
  }

  .col-debit {
    width: 82px;
  }

  .col-credit {
    width: 82px;
  }


  /* ================================================================
     TABLE HEADER
     ================================================================ */

  thead {

    display: table-header-group;
  }


  thead td {

    border-top: 1px solid #000;

    border-bottom: 1px solid #000;

    font-size: 8px;

    font-weight: 700;

    padding:
      4px
      5px;

    vertical-align: middle;
  }


  .header-right {
    text-align: right;
  }


  /* ================================================================
     VOUCHER GROUP
     ================================================================ */

  tbody.voucher-group {

    break-inside: avoid-page;

    page-break-inside: avoid;
  }


  tbody td {

    padding:
      1px
      5px;

    vertical-align: top;

    line-height: 1.28;

    overflow-wrap: anywhere;
  }


  /* ================================================================
     MAIN VOUCHER ROW
     ================================================================ */

  .voucher-row td {

    padding-top: 5px;

    padding-bottom: 2px;

    font-size: 8.5px;
  }


  .date-cell {

    white-space: nowrap;
  }


  .particulars-cell {

    white-space: normal;
  }


  .party-name {

    font-weight: 600;
  }


  .voucher-type-cell {

    white-space: nowrap;
  }


  .voucher-no-cell {

    text-align: right;

    white-space: nowrap;
  }


  .amount-cell {

    text-align: right;

    white-space: nowrap;
  }


  /* ================================================================
     DETAIL GROUP
     Example:
     Sales - Spare Parts
     ================================================================ */

  .detail-group-row td {

    padding-top: 2px;

    padding-bottom: 1px;
  }


  .detail-group-name {

    padding-left: 12px !important;

    font-size: 8px;

    font-weight: 600;

    color: #111;
  }


  /* ================================================================
     INVENTORY ITEM
     Example:
     EICHER MILE MAX DEF 1/20 L
                              20 nos
                                             1,610.20 Cr
     ================================================================ */

  .detail-item-row td {

    padding-top: 1px;

    padding-bottom: 1px;

    font-size: 7.8px;
  }


  .stock-item-name {

    padding-left: 22px !important;

    white-space: normal;

    color: #333;
  }


  .stock-qty {

    text-align: right;

    white-space: nowrap;

    font-size: 7.5px;

    color: #333;
  }


  /* ================================================================
     NORMAL DETAIL LEDGER
     CGST / SGST / Round Off
     ================================================================ */

  .detail-ledger-row td {

    padding-top: 1px;

    padding-bottom: 1px;

    font-size: 7.8px;
  }


  .detail-ledger-name {

    padding-left: 12px !important;

    color: #333;
  }


  .detail-amount {

    text-align: right;

    white-space: nowrap;

    color: #111;

    font-size: 7.8px;
  }


  /* ================================================================
     NARRATION
     ================================================================ */

  .narration-row td {

    padding-top: 2px;

    padding-bottom: 1px;
  }


  .narration-cell {

    padding-left: 14px !important;

    font-size: 8px;

    color: #333;

    white-space: pre-wrap;
  }


  /* ================================================================
     TOTALS
     ================================================================ */

  tfoot td {

    border-top: 1px solid #000;

    padding:
      4px
      5px;

    font-size: 8.5px;
  }


  .total-amount {

    text-align: right;

    font-weight: 700;

    white-space: nowrap;
  }


  .closing-row td {

    border-top: none;

    font-weight: 400;
  }


  .grand-row td {

    border-top: 1px solid #000;

    border-bottom: 3px double #000;

    font-weight: 700;
  }


  /* ================================================================
     PRINT
     ================================================================ */

  @page {

    size: A4;

    margin:
      30px
      16px
      18px
      16px;
  }

</style>

</head>


<body>

<div class="page">


  ${buildHeaderHtml({
    company,
    ledgerName,
    fromDate,
    toDate,
  })}


  <table>

    <colgroup>

      <col class="col-date" />

      <col />

      <col class="col-type" />

      <col class="col-no" />

      <col class="col-debit" />

      <col class="col-credit" />

    </colgroup>


    <thead>

      <tr>

        <td>
          Date
        </td>

        <td>
          Particulars
        </td>

        <td>
          Vch Type
        </td>

        <td class="header-right">
          Vch No.
        </td>

        <td class="header-right">
          Debit
        </td>

        <td class="header-right">
          Credit
        </td>

      </tr>

    </thead>


    ${
      opening !== 0
        ? `
          <tbody class="voucher-group">

            <tr class="voucher-row">

              <td class="date-cell">
                ${formatDate(fromDate)}
              </td>

              <td class="particulars-cell">
                Opening Balance
              </td>

              <td></td>

              <td></td>

              <td class="amount-cell">
                ${
                  opening > 0
                    ? money(opening)
                    : ""
                }
              </td>

              <td class="amount-cell">
                ${
                  opening < 0
                    ? money(Math.abs(opening))
                    : ""
                }
              </td>

            </tr>

          </tbody>
        `
        : ""
    }


    ${
      rowsHtml ||
      `
        <tbody>

          <tr>

            <td
              colspan="6"
              style="
                text-align:center;
                padding:15px;
                color:#666;
              "
            >
              No transactions in this period
            </td>

          </tr>

        </tbody>
      `
    }


    <tfoot>


      <tr>

        <td></td>
        <td></td>
        <td></td>
        <td></td>

        <td class="total-amount">
          ${
            money(
              runningDebit +
              (
                opening > 0
                  ? opening
                  : 0
              )
            )
          }
        </td>

        <td class="total-amount">
          ${
            money(
              runningCredit +
              (
                opening < 0
                  ? Math.abs(opening)
                  : 0
              )
            )
          }
        </td>

      </tr>


      <tr class="closing-row">

        <td></td>

        <td>
          By Closing Balance
        </td>

        <td></td>
        <td></td>

        <td class="total-amount">
          ${
            !closingIsDebit
              ? money(Math.abs(closing))
              : ""
          }
        </td>

        <td class="total-amount">
          ${
            closingIsDebit
              ? money(closing)
              : ""
          }
        </td>

      </tr>


      <tr class="grand-row">

        <td></td>
        <td></td>
        <td></td>
        <td></td>

        <td class="total-amount">
          ${money(grandDebit)}
        </td>

        <td class="total-amount">
          ${money(grandCredit)}
        </td>

      </tr>


    </tfoot>

  </table>

</div>

</body>

</html>
  `;
}


/* ==========================================================================
   PDF GENERATION
   ========================================================================== */

export async function buildLedgerPdf(payload) {
  const mode =
    VALID_MODES.includes(payload.mode)
      ? payload.mode
      : "simple";


  const html =
    buildHtml({
      ...payload,
      mode,
    });


  const browser =
    await puppeteer.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });


  try {
    const page =
      await browser.newPage();


    await page.setContent(
      html,
      {
        waitUntil: "networkidle0",
      }
    );


    const pdf =
      await page.pdf({
        format: "A4",

        printBackground: true,

        displayHeaderFooter: true,

        headerTemplate: `
          <div
            style="
              width:100%;
              font-size:8px;
              text-align:right;
              padding:0 16px;
              color:#000;
            "
          >
            Page
            <span class="pageNumber"></span>
          </div>
        `,

        footerTemplate:
          `<div></div>`,

        margin: {
          top: "30px",
          bottom: "18px",
          left: "16px",
          right: "16px",
        },
      });


    return Buffer.from(pdf);

  } finally {
    await browser.close();
  }
}