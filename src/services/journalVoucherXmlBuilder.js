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

function formatTallyDate(date) {
  if (!date) {
    throw new Error("Voucher date is required");
  }

  const value = String(date);

  if (/^\d{8}$/.test(value)) {
    return value;
  }

  const parts = value.split("-");

  if (parts.length !== 3) {
    throw new Error(
      "Invalid voucher date. Use YYYY-MM-DD"
    );
  }

  const [year, month, day] = parts;

  return `${year}${month}${day}`;
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
    throw new Error(
      "At least one voucher entry is required"
    );
  }

  const totalDebit = entries
    .filter(
      (entry) =>
        String(entry.entry_type).toLowerCase() ===
        "debit"
    )
    .reduce(
      (sum, entry) =>
        sum + Number(entry.amount),
      0
    );

  const totalCredit = entries
    .filter(
      (entry) =>
        String(entry.entry_type).toLowerCase() ===
        "credit"
    )
    .reduce(
      (sum, entry) =>
        sum + Number(entry.amount),
      0
    );

  if (
    Math.abs(totalDebit - totalCredit) >
    0.01
  ) {
    throw new Error(
      `Voucher is not balanced. Debit=${totalDebit}, Credit=${totalCredit}`
    );
  }

  const tallyDate =
    formatTallyDate(voucherDate);

  const ledgerEntries = entries
    .map((entry) => {
      const type =
        String(entry.entry_type).toLowerCase();

      const amount = Number(entry.amount);

      if (!entry.ledger_name) {
        throw new Error(
          "ledger_name is required"
        );
      }

      if (!["debit", "credit"].includes(type)) {
        throw new Error(
          "entry_type must be debit or credit"
        );
      }

      const tallyAmount =
        type === "debit"
          ? amount
          : -amount;

      return `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${escapeXml(
            entry.ledger_name
          )}</LEDGERNAME>

          <ISDEEMEDPOSITIVE>${
            type === "debit"
              ? "No"
              : "Yes"
          }</ISDEEMEDPOSITIVE>

          <AMOUNT>${tallyAmount.toFixed(
            2
          )}</AMOUNT>
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
          <SVCURRENTCOMPANY>
            ${escapeXml(company)}
          </SVCURRENTCOMPANY>
        </STATICVARIABLES>

      </REQUESTDESC>

      <REQUESTDATA>

        <TALLYMESSAGE>

          <VOUCHER
            VCHTYPE="${escapeXml(
              voucherType
            )}"
            ACTION="Create">

            <DATE>${tallyDate}</DATE>

            ${
              voucherNumber
                ? `<VOUCHERNUMBER>${escapeXml(
                    voucherNumber
                  )}</VOUCHERNUMBER>`
                : ""
            }

            <VOUCHERTYPENAME>
              ${escapeXml(voucherType)}
            </VOUCHERTYPENAME>

            <NARRATION>
              ${escapeXml(narration || "")}
            </NARRATION>

            ${ledgerEntries}

          </VOUCHER>

        </TALLYMESSAGE>

      </REQUESTDATA>

    </IMPORTDATA>

  </BODY>

</ENVELOPE>`;
}