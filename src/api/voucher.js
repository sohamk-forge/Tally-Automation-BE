

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


export const IFSC_PREFIX_TO_BANK = {
  // Public sector banks
  SBIN: "STATE BANK OF INDIA",
  BARB: "BANK OF BARODA",
  BKID: "BANK OF INDIA",
  MAHB: "BANK OF MAHARASHTRA",
  CNRB: "CANARA BANK",
  CBIN: "CENTRAL BANK OF INDIA",
  IDIB: "INDIAN BANK",
  IOBA: "INDIAN OVERSEAS BANK",
  PSIB: "PUNJAB & SIND BANK",
  PUNB: "PUNJAB NATIONAL BANK",
  UCBA: "UCO BANK",
  UBIN: "UNION BANK OF INDIA",

  // Private sector banks
  UTIB: "AXIS BANK",
  BDBL: "BANDHAN BANK",
  CSBK: "CSB BANK",
  CIUB: "CITY UNION BANK",
  DCBL: "DCB BANK",
  DLXB: "DHANLAXMI BANK",
  FDRL: "FEDERAL BANK",
  // HDFC deliberately excluded — its .xls exports render the IFSC
  // mangled (e.g. "H0001782"), so it's detected via layout fingerprint
  // (looksLikeHdfc) instead, not via this map.
  ICIC: "ICICI BANK",
  INDB: "INDUSIND BANK",
  IDFB: "IDFC FIRST BANK",
  JAKA: "JAMMU & KASHMIR BANK",
  KARB: "KARNATAKA BANK",
  KVBL: "KARUR VYSYA BANK",
  KKBK: "KOTAK MAHINDRA BANK",
  NTBL: "NAINITAL BANK",
  RATN: "RBL BANK",
  SIBL: "SOUTH INDIAN BANK",
  TMBL: "TAMILNAD MERCANTILE BANK",
  YESB: "YES BANK",
  IBKL: "IDBI BANK",

  // Small finance banks — verify these before trusting in production
  AUBL: "AU SMALL FINANCE BANK",
  ESFB: "EQUITAS SMALL FINANCE BANK",
  SURY: "SURYODAY SMALL FINANCE BANK",
  UJVN: "UJJIVAN SMALL FINANCE BANK",
  UTKS: "UTKARSH SMALL FINANCE BANK",
  JSFB: "JANA SMALL FINANCE BANK",

  // Payments banks — verify before trusting in production
  IPOS: "INDIA POST PAYMENTS BANK",
  FINO: "FINO PAYMENTS BANK",
  PYTM: "PAYTM PAYMENTS BANK",
  AIRP: "AIRTEL PAYMENTS BANK",
  NSPB: "NSDL PAYMENTS BANK"

};



export const BANK_NAME_KEYWORDS = {
  "STATE BANK OF INDIA": /\bsbi\b|state bank of india/i,
  "BANK OF BARODA": /bank of baroda|\bbob\b/i,
  "BANK OF INDIA": /\bbank of india\b(?!.{0,20}(overseas|central|maharashtra))/i,
  "BANK OF MAHARASHTRA": /bank of maharashtra/i,
  "CANARA BANK": /canara bank/i,
  "CENTRAL BANK OF INDIA": /central bank of india/i,
  "INDIAN BANK": /\bindian bank\b(?!.{0,15}overseas)/i,
  "INDIAN OVERSEAS BANK": /indian overseas bank/i,
  "PUNJAB & SIND BANK": /punjab\s*&?\s*sind bank/i,
  "PUNJAB NATIONAL BANK": /\bpnb\b|punjab national bank/i,
  "UCO BANK": /\buco bank\b/i,
  "UNION BANK OF INDIA": /union bank of india/i,

  "AXIS BANK": /\baxis bank\b/i,
  "BANDHAN BANK": /bandhan bank/i,
  "CSB BANK": /\bcsb bank\b|catholic syrian bank/i,
  "CITY UNION BANK": /city union bank/i,
  "DCB BANK": /\bdcb bank\b|development credit bank/i,
  "DHANLAXMI BANK": /dhanlaxmi bank/i,
  "FEDERAL BANK": /federal bank/i,
  "HDFC BANK": /hdfc/i,
  "ICICI BANK": /icici/i,
  "INDUSIND BANK": /indusind bank/i,
  "IDFC FIRST BANK": /idfc first bank/i,
  "JAMMU & KASHMIR BANK": /jammu\s*(?:&|and)?\s*kashmir bank/i,
  "KARNATAKA BANK": /karnataka bank/i,
  "KARUR VYSYA BANK": /karur vysya bank/i,
  "KOTAK MAHINDRA BANK": /kotak mahindra bank/i,
  "NAINITAL BANK": /nainital bank/i,
  "RBL BANK": /\brbl bank\b/i,
  "SOUTH INDIAN BANK": /south indian bank/i,
  "TAMILNAD MERCANTILE BANK": /tamilnad mercantile bank/i,
  "YES BANK": /\byes bank\b/i,
  "IDBI BANK": /\bidbi bank\b/i,

  "AU SMALL FINANCE BANK": /au small finance bank/i,
  "CAPITAL SMALL FINANCE BANK": /capital small finance bank/i,
  "EQUITAS SMALL FINANCE BANK": /equitas small finance bank/i,
  "ESAF SMALL FINANCE BANK": /esaf small finance bank/i,
  "SURYODAY SMALL FINANCE BANK": /suryoday small finance bank/i,
  "UJJIVAN SMALL FINANCE BANK": /ujjivan small finance bank/i,
  "UTKARSH SMALL FINANCE BANK": /utkarsh small finance bank/i,
  "SLICE SMALL FINANCE BANK": /slice small finance bank/i,
  "JANA SMALL FINANCE BANK": /jana small finance bank/i,
  "SHIVALIK SMALL FINANCE BANK": /shivalik small finance bank/i,
  "UNITY SMALL FINANCE BANK": /unity small finance bank/i,

  "INDIA POST PAYMENTS BANK": /india post payments bank/i,
  "FINO PAYMENTS BANK": /fino payments bank/i,
  "PAYTM PAYMENTS BANK": /paytm payments bank/i,
  "AIRTEL PAYMENTS BANK": /airtel payments bank/i,
  "NSDL PAYMENTS BANK": /nsdl payments bank/i,

  // Regional Rural Banks — kept as name-only matches (no IFSC map).
  "ANDHRA PRADESH GRAMEENA BANK": /andhra pradesh grameena bank/i,
  "ASSAM GRAMIN BANK": /assam gramin bank/i,
  "ARUNACHAL PRADESH RURAL BANK": /arunachal pradesh rural bank/i,
  "BIHAR GRAMIN BANK": /bihar gramin bank/i,
  "CHHATTISGARH GRAMIN BANK": /chhattisgarh gramin bank/i,
  "GUJARAT GRAMIN BANK": /gujarat gramin bank/i,
  "HARYANA GRAMIN BANK": /haryana gramin bank/i,
  "HIMACHAL PRADESH GRAMIN BANK": /himachal pradesh gramin bank/i,
  "JHARKHAND GRAMIN BANK": /jharkhand gramin bank/i,
  "JAMMU AND KASHMIR GRAMEEN BANK": /jammu (?:and|&) kashmir grameen bank/i,
  "KARNATAKA GRAMEENA BANK": /karnataka grameena bank/i,
  "KERALA GRAMEENA BANK": /kerala grameena bank/i,
  "MAHARASHTRA GRAMIN BANK": /maharashtra gramin bank/i,
  "MADHYA PRADESH GRAMIN BANK": /madhya pradesh gramin bank/i,
  "MANIPUR RURAL BANK": /manipur rural bank/i,
  "MEGHALAYA RURAL BANK": /meghalaya rural bank/i,
  "MIZORAM RURAL BANK": /mizoram rural bank/i,
  "NAGALAND RURAL BANK": /nagaland rural bank/i,
  "ODISHA GRAMEEN BANK": /odisha grameen bank/i,
  "PUNJAB GRAMIN BANK": /punjab gramin bank/i,
  "PUDUCHERRY GRAMA BANK": /puducherry grama bank/i,
  "RAJASTHAN GRAMIN BANK": /rajasthan gramin bank/i,
  "TAMIL NADU GRAMA BANK": /tamil nadu grama bank/i,
  "TELANGANA GRAMEENA BANK": /telangana grameena bank/i,
  "TRIPURA GRAMIN BANK": /tripura gramin bank/i,
  "UTTAR PRADESH GRAMIN BANK": /uttar pradesh gramin bank/i,
  "UTTARAKHAND GRAMIN BANK": /uttarakhand gramin bank/i,
  "WEST BENGAL GRAMIN BANK": /west bengal gramin bank/i
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

  console.log("=== BANK DETECT DEBUG ===");
  console.log("allText length:", allText.length);
  console.log("allText sample:", allText.slice(0, 500));
  console.log("hasBankLtd:", /\bBANK Ltd\.?/i.test(allText));
  console.log("hasCustId:", /Cust ID\s*:/i.test(allText));
  console.log("hasNomination:", /Nomination\s*:/i.test(allText));
  console.log("hasOdLimit:", /OD Limit\s*:/i.test(allText));

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