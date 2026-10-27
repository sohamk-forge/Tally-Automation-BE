const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function formatTallyDate(value) {
  const date =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? "").trim().slice(0, 10);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("voucher_date must be a valid YYYY-MM-DD date");
  }

  return date.replace(/-/g, "");
}

function createInventoryEntry(entry, direction) {
  const isIn = direction === "IN";
  const godown = isIn ? entry.to_godown : entry.from_godown;

  const quantity = Number(entry.quantity);
  const rate = Number(entry.rate);
  const amount = (quantity * rate).toFixed(2);

  if (
    !entry.stock_item_name ||
    !entry.unit ||
    !entry.from_godown ||
    !entry.to_godown ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(rate) ||
    rate < 0
  ) {
    throw new Error(
      "Invalid stock item, unit, godown, quantity or rate"
    );
  }

  const deemedPositive = isIn ? "Yes" : "No";
  const signedAmount = isIn ? `-${amount}` : amount;
  const batchName = entry.batch_name || "Primary Batch";
  const qty = `${quantity} ${escapeXml(entry.unit)}`;

  return `
    <INVENTORYENTRIES${direction}.LIST>
      <STOCKITEMNAME>${escapeXml(entry.stock_item_name)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>
      <RATE>${rate.toFixed(2)}/${escapeXml(entry.unit)}</RATE>
      <AMOUNT>${signedAmount}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${escapeXml(godown)}</GODOWNNAME>
        <BATCHNAME>${escapeXml(batchName)}</BATCHNAME>
        <AMOUNT>${signedAmount}</AMOUNT>
        <ACTUALQTY>${qty}</ACTUALQTY>
        <BILLEDQTY>${qty}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>
    </INVENTORYENTRIES${direction}.LIST>
  `;
}

export function createStockJournalXML({
  company,
  voucherDate,
  voucherNumber,
  narration,
  entries,
}) {
  if (!company || !Array.isArray(entries) || entries.length === 0) {
    throw new Error("Company and at least one stock entry are required");
  }

  const date = formatTallyDate(voucherDate);

  const inventoryXml = entries
    .map(
      (entry) =>
        createInventoryEntry(entry, "IN") +
        createInventoryEntry(entry, "OUT")
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
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
          <VOUCHER VCHTYPE="Stock Journal" ACTION="Create"
            OBJVIEW="Consumption Voucher View">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>
            <NARRATION>${escapeXml(narration)}</NARRATION>
            ${inventoryXml}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}