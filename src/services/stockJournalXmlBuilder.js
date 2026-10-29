
import fs from "node:fs/promises";
import path from "node:path";

const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function formatTallyDate(value) {
  let date;

  if (value instanceof Date) {
    // Preserve the calendar date returned by PostgreSQL.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    date = `${year}-${month}-${day}`;
  } else {
    date = String(value ?? "").trim();

    // Support ISO date strings with a time component.
    if (/^\d{4}-\d{2}-\d{2}T/.test(date)) {
      date = date.slice(0, 10);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `Invalid voucher_date: ${String(value)}. Expected YYYY-MM-DD`
    );
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid calendar date: ${date}`);
  }

  return date.replace(/-/g, "");
}

function createInventoryEntry(entry, direction) {
  const isIn = direction === "IN";

  // IN = destination; OUT = source.
  const godown = isIn
    ? entry.to_godown
    : entry.from_godown;

  const unit = isIn
    ? entry.to_unit ?? entry.unit
    : entry.from_unit ?? entry.unit;

  const quantity = Number(
    isIn
      ? entry.to_quantity ?? entry.quantity
      : entry.from_quantity ?? entry.quantity
  );

  const rate = Number(
    isIn
      ? entry.to_rate ?? entry.rate
      : entry.from_rate ?? entry.rate
  );

  if (
    !entry.stock_item_name ||
    !godown ||
    !unit ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(rate) ||
    rate < 0
  ) {
    throw new Error(
      `Invalid ${direction} stock entry: check stock item, ` +
      "godown, unit, quantity and rate"
    );
  }

  const amount = (quantity * rate).toFixed(2);
  const deemedPositive = isIn ? "Yes" : "No";
  const signedAmount = isIn ? `-${amount}` : amount;
  const qty = `${quantity} ${escapeXml(unit)}`;

  console.log(
    `[STOCK JOURNAL] ${direction}:`,
    {
      stock_item_name: entry.stock_item_name,
      godown,
      quantity,
      unit,
      rate,
      amount,
    }
  );

  return `
    <INVENTORYENTRIES${direction}.LIST>
      <STOCKITEMNAME>${escapeXml(entry.stock_item_name)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>
      <RATE>${rate.toFixed(2)}/${escapeXml(unit)}</RATE>
      <AMOUNT>${signedAmount}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${escapeXml(godown)}</GODOWNNAME>
        <AMOUNT>${signedAmount}</AMOUNT>
        <ACTUALQTY>${qty}</ACTUALQTY>
        <BILLEDQTY>${qty}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>
    </INVENTORYENTRIES${direction}.LIST>`;
}

export async function createStockJournalXML({
  company,
  voucherDate,
  voucherNumber,
  narration,
  entries,
}) {
  if (!company || !Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      "Company and at least one stock entry are required"
    );
  }

  const date = formatTallyDate(voucherDate);

  const inventoryXml = entries
    .map(
      (entry) =>
        createInventoryEntry(entry, "IN") +
        createInventoryEntry(entry, "OUT")
    )
    .join("\n");

  const voucherNumberXml =
    voucherNumber !== null &&
    voucherNumber !== undefined &&
    String(voucherNumber).trim() !== ""
      ? `<VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>`
      : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE>
          <VOUCHER
            VCHTYPE="Stock Journal"
            ACTION="Create"
            OBJVIEW="Consumption Voucher View">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
            ${voucherNumberXml}
            <NARRATION>${escapeXml(narration)}</NARRATION>
            ${inventoryXml}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  // Save generated XML for debugging.
  const outputDir = path.join(process.cwd(), "generated-xml");
  await fs.mkdir(outputDir, { recursive: true });

  const safeVoucherNumber = String(voucherNumber ?? "unnumbered")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 60) || "unnumbered";

  const fileName =
    `stock-journal-${safeVoucherNumber}-${Date.now()}.xml`;

  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, xml, "utf8");

  console.log("Stock Journal XML saved:", filePath);

  return xml;
}
