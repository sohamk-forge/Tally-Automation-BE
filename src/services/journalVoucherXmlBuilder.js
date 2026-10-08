function escapeXml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const pad = (n) => String(n).padStart(2, "0");

function formatTallyDate(date) {
  if (!date) {
    throw new Error("Voucher date is required");
  }

  // pg returns DATE columns as a JS Date (local midnight) unless a type
  // parser is registered — String(date) of that has no "-" to split on.
  // Local getters (not toISOString) so a +05:30 server doesn't shift the
  // voucher back a day.
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid voucher date");
    }

    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  const value = String(date);

  if (/^\d{8}$/.test(value)) {
    return value;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    throw new Error("Invalid voucher date. Use YYYY-MM-DD");
  }

  return `${match[1]}${match[2]}${match[3]}`;
}

export function createJournalVoucherXML({
  company,
  voucherDate,
  voucherNumber,
  voucherType = "Journal",
  narration,
  entries
}) {
  if (!company) {
    throw new Error("Company is required");
  }

  if (!entries || !entries.length) {
    throw new Error("At least one voucher entry is required");
  }

  const totalDebit = entries
    .filter(
      (entry) =>
        String(entry.entry_type).toLowerCase() === "debit"
    )
    .reduce((sum, entry) => sum + Number(entry.amount), 0);

  const totalCredit = entries
    .filter(
      (entry) =>
        String(entry.entry_type).toLowerCase() === "credit"
    )
    .reduce((sum, entry) => sum + Number(entry.amount), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Voucher is not balanced. Debit=${totalDebit}, Credit=${totalCredit}`
    );
  }

  const tallyDate = formatTallyDate(voucherDate);

  const ledgerEntries = entries
    .map((entry) => {
      const type = String(entry.entry_type).toLowerCase();

      if (!entry.ledger_name) {
        throw new Error("ledger_name is required");
      }

      if (!["debit", "credit"].includes(type)) {
        throw new Error("entry_type must be debit or credit");
      }

      const isDebit = type === "debit";

      // Tally's import convention: a DEBIT line is ISDEEMEDPOSITIVE=Yes with
      // a NEGATIVE amount; a CREDIT line is No with a POSITIVE amount.
      // (The reverse posts every Dr as a Cr.)
      const amount = Number(entry.amount);
      const signedAmount = isDebit ? -amount : amount;

      return `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(entry.ledger_name)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
          <AMOUNT>${signedAmount.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      `;
    })
    .join("");

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

          <VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create">

            <DATE>${tallyDate}</DATE>

            ${
              voucherNumber
                ? `<VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>`
                : ""
            }

            <VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>

            <NARRATION>${escapeXml(narration || "")}</NARRATION>

            ${ledgerEntries}

          </VOUCHER>

        </TALLYMESSAGE>

      </REQUESTDATA>

    </IMPORTDATA>

  </BODY>

</ENVELOPE>`;
}
