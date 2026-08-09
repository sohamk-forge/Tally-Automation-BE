

import pool from "../db/index.js";

/*
====================================
DATE FORMATTING
====================================
*/

export function formatVoucherDate(rawDate, voucherId) {
  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) {
      throw new Error(`Voucher ${voucherId}: voucher_date is an invalid Date object`);
    }
    const yyyy = rawDate.getUTCFullYear();
    const mm = String(rawDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(rawDate.getUTCDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }
  const str = String(rawDate || "").trim();
  if (/^\d{8}$/.test(str)) return str;
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, yyyy, mm, dd] = isoMatch;
    return `${yyyy}${mm}${dd}`;
  }
  throw new Error(`Voucher ${voucherId}: unable to parse voucher_date "${str}" into YYYYMMDD`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function yyyymmddToTallyDisplay(yyyymmdd) {
  const str = String(yyyymmdd);
  const yyyy = str.slice(0, 4);
  const mm = Number(str.slice(4, 6));
  const dd = str.slice(6, 8);
  return `${dd}-${MONTHS[mm - 1]}-${yyyy}`;
}

/*
====================================
BANK DETECTION — statement upload validation

Matches the frontend's fixed 20-bank dropdown. Confirms the uploaded
statement's actual bank matches the bank_name the user selected
(NOT bank_ledger — that's a free-form Tally ledger account name and
can be anything) BEFORE any row is inserted into contra_vouchers.
====================================
*/

export const IFSC_PREFIX_TO_BANK = {
  SBIN: "State Bank of India",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda",
  KKBK: "Kotak Mahindra Bank",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  IBKL: "IDBI Bank",
  INDB: "IndusInd Bank",
  YESB: "Yes Bank",
  BKID: "Bank of India",
  CBIN: "Central Bank of India",
  IOBA: "Indian Overseas Bank",
  UCBA: "UCO Bank",
  MAHB: "Bank of Maharashtra",
  PSIB: "Punjab & Sind Bank",
  IDFB: "IDFC First Bank",
  FDRL: "Federal Bank"
  // NOTE: HDFC deliberately excluded here — its IFSC comes through
  // mangled in .xls exports (e.g. "H0001782" instead of "HDFC0001782").
  // HDFC is detected separately below via structural fingerprint.
};

const BANK_NAME_KEYWORDS = {
  "State Bank of India": /\bsbi\b|state bank of india/i,
  "ICICI Bank": /icici/i,
  "Axis Bank": /\baxis\b/i,
  "Punjab National Bank": /\bpnb\b|punjab national/i,
  "Bank of Baroda": /bank of baroda|\bbob\b/i,
  "Kotak Mahindra Bank": /kotak/i,
  "Canara Bank": /canara/i,
  "Union Bank of India": /union bank/i,
  "IDBI Bank": /\bidbi\b/i,
  "IndusInd Bank": /indusind/i,
  "Yes Bank": /\byes bank\b/i,
  "Bank of India": /\bbank of india\b(?!.{0,15}(central|overseas))/i,
  "Central Bank of India": /central bank of india/i,
  "Indian Overseas Bank": /indian overseas/i,
  "UCO Bank": /\buco bank\b/i,
  "Bank of Maharashtra": /bank of maharashtra/i,
  "Punjab & Sind Bank": /punjab\s*&?\s*sind bank/i,
  "IDFC First Bank": /idfc first/i,
  "Federal Bank": /federal bank/i
};

// HDFC-specific fallback: its own .xls export renders the bank name/IFSC
// with dropped letters (e.g. "H BANK Ltd.", "H0001782"), so we detect it
// via the structural fingerprint of its statement layout instead.
function looksLikeHdfc(allText) {
  const hasBankLtd = /\bBANK Ltd\.?/i.test(allText);
  const hasCustId = /Cust ID\s*:/i.test(allText);
  const hasNomination = /Nomination\s*:/i.test(allText);
  const hasOdLimit = /OD Limit\s*:/i.test(allText);
  const hits = [hasBankLtd, hasCustId, hasNomination, hasOdLimit].filter(Boolean).length;
  return hits >= 2;
}

export function detectBankFromSheet(sheet, xlsxUtils) {
  if (!sheet["!ref"]) return { detected: null, evidence: null };

  const range = xlsxUtils.decode_range(sheet["!ref"]);
  const scanRows = Math.min(range.e.r, 40);

  let allText = "";
  for (let r = range.s.r; r <= scanRows; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[xlsxUtils.encode_cell({ r, c })];
      if (cell && cell.v != null) allText += " " + String(cell.v);
    }
  }

  const ifscMatch = allText.match(/\b([A-Z]{4})0[A-Z0-9]{6}\b/);
  if (ifscMatch && IFSC_PREFIX_TO_BANK[ifscMatch[1]]) {
    return { detected: IFSC_PREFIX_TO_BANK[ifscMatch[1]], evidence: `IFSC ${ifscMatch[0]}` };
  }

  if (looksLikeHdfc(allText)) {
    return { detected: "HDFC Bank", evidence: "HDFC statement layout fingerprint" };
  }

  for (const [label, pattern] of Object.entries(BANK_NAME_KEYWORDS)) {
    if (pattern.test(allText)) {
      return { detected: label, evidence: "bank name text match" };
    }
  }

  return { detected: null, evidence: null };
}

// Validates against bank NAME (the fixed dropdown value, e.g. "HDFC
// Bank"), not bank_ledger. bank_ledger is a free-form Tally ledger
// account name and is irrelevant to this check.
export function validateBankMatchesLedger(sheet, bankName, xlsxUtils) {
  const { detected, evidence } = detectBankFromSheet(sheet, xlsxUtils);

  if (!detected) {
    return { ok: true, verified: false };
  }

  const normalizedDetected = detected.trim().toLowerCase();
  const normalizedExpected = String(bankName || "").trim().toLowerCase();

  const isMatch = normalizedExpected === normalizedDetected;

  if (!isMatch) {
    return {
      ok: false,
      verified: true,
      detected,
      expected: bankName,
      message:
        `This looks like a ${detected} statement (${evidence}), but you selected ` +
        `"${bankName}" as the bank. Please select the correct bank or re-upload the correct statement.`
    };
  }

  return { ok: true, verified: true, detected };
}

/*
====================================
ACTIVE — DIRECT DB DUPLICATE CHECK

Queries app_test.vouchers directly. No Tally connection of any kind —
relies entirely on whatever data your existing periodic/manual
/voucher-sync runs have already populated. Party-ledger assignment and
the pre-push worker check are fully independent of Tally reachability.

Uses the party_ledger_name column directly, and inspects ledger_entries
(jsonb) to confirm the bank ledger + amount side of the entry.
====================================
*/

export async function checkDuplicateFromDb({
  companyId, voucherType, voucherDate, partyLedger, bankLedger, amount
}) {
  const displayType = { payment: "Payment", receipt: "Receipt", contra: "Contra" }[
    String(voucherType || "").toLowerCase()
  ];

  const normParty = String(partyLedger || "").trim().toLowerCase();
  const normBank = String(bankLedger || "").trim().toLowerCase();
  const targetAmount = Math.abs(Number(amount));

  const result = await pool.query(
    `
    SELECT id, voucher_number, guid, party_ledger_name, ledger_entries
    FROM app_test.vouchers
    WHERE company_id = $1
      AND voucher_date = $2
      AND voucher_type ILIKE $3
      AND LOWER(TRIM(party_ledger_name)) = $4
    `,
    [companyId, voucherDate, displayType, normParty]
  );

  const matches = result.rows.filter((row) => {
    const entries = Array.isArray(row.ledger_entries)
      ? row.ledger_entries
      : typeof row.ledger_entries === "string"
      ? (() => { try { return JSON.parse(row.ledger_entries); } catch { return []; } })()
      : row.ledger_entries ? [row.ledger_entries] : [];

    const hasBank = entries.some((e) =>
      String(e.LEDGERNAME || "").trim().toLowerCase() === normBank &&
      Math.abs(Math.abs(Number(e.AMOUNT)) - targetAmount) <= 0.01);

    const hasAnyMatchingAmount = entries.some((e) =>
      Math.abs(Math.abs(Number(e.AMOUNT)) - targetAmount) <= 0.01);

    // Prefer an exact bank-ledger-name + amount match. If the bank
    // ledger name doesn't line up exactly (naming differences between
    // Tally and your bank_ledger field), fall back to amount-only
    // matching within this already-narrowed (company + date + type +
    // party) result set, so a naming mismatch alone doesn't hide a
    // real duplicate.
    return hasBank || hasAnyMatchingAmount;
  });

  if (!matches.length) {
    return { exists: false, message: "No matching voucher found in synced data." };
  }

  return {
    exists: true,
    message: "A voucher with the same date, amount, party ledger and bank ledger already exists in Tally.",
    matches: matches.map((m) => ({ voucherNumber: m.voucher_number, guid: m.guid }))
  };
}