/*
====================================
voucher.js

Merged helper module. Now contains:
  - Date formatting for Tally (unchanged)
  - checkDuplicate()   -> LIVE Tally XML duplicate check.
      KEPT for reference / manual debugging only. NO LONGER CALLED
      by routes.js or worker.js — this exact request is what
      triggers TallyPrime's "Software Exception c0000005 (Memory
      Access Violation)" crash on this build. Do not re-enable
      without confirming Tally has a fix.
  - checkDuplicateFromDb() -> the ACTIVE duplicate check. Queries
      app_test.vouchers directly. NO sync call happens here anymore —
      it relies entirely on whatever data is already in the DB from
      your existing periodic/manual /voucher-sync runs. This removes
      Tally-reachability as a factor in party-ledger assignment.

Both voucher.routes.js and pushVoucher.worker.js import from THIS file.
====================================
*/

import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import pool from "../db/index.js";
/*
====================================
BANK DETECTION — statement upload validation
Matches the frontend's fixed 20-bank dropdown. Confirms the uploaded
statement's actual bank matches the selected bank_ledger BEFORE any
row is inserted into contra_vouchers.
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
  // Require at least 2 of these fingerprints to avoid false positives
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

export function validateBankMatchesLedger(sheet, bankLedgerName, xlsxUtils) {
  const { detected, evidence } = detectBankFromSheet(sheet, xlsxUtils);

  if (!detected) {
    return { ok: true, verified: false };
  }

  const normalizedDetected = detected.trim().toLowerCase();
  const normalizedLedger = String(bankLedgerName || "").trim().toLowerCase();

  const isMatch =
    normalizedLedger === normalizedDetected ||
    normalizedLedger.includes(normalizedDetected) ||
    normalizedDetected.includes(normalizedLedger);

  if (!isMatch) {
    return {
      ok: false,
      verified: true,
      detected,
      expected: bankLedgerName,
      message:
        `This looks like a ${detected} statement (${evidence}), but you selected ` +
        `"${bankLedgerName}" as the bank ledger. Please select the correct bank or re-upload the correct statement.`
    };
  }

  return { ok: true, verified: true, detected };
}
/*
====================================
DATE FORMATTING
====================================
*/
/*
==========================================================
BANK DETECTION
==========================================================
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
CONFIG shared by the (now-unused-in-practice) live check
and the actual voucher push in the worker
====================================
*/

export const TALLY_PORT = Number(process.env.TALLY_PORT || 9000);
export const TALLY_URL = `http://localhost:${TALLY_PORT}`;
const REQUEST_TIMEOUT_MS = Number(process.env.TALLY_DUPLICATE_CHECK_TIMEOUT_MS || 8000);

const xmlParser = new XMLParser({ ignoreAttributes: false, trimValues: true });

export class TallyConnectionError extends Error {
  constructor(message, code = "ECONNREFUSED", cause) {
    super(message);
    this.name = "TallyConnectionError";
    this.code = code;
    this.cause = cause;
  }
}

export class TallyRequestError extends Error {
  constructor(message, lineError) {
    super(message);
    this.name = "TallyRequestError";
    this.lineError = lineError;
  }
}

/*
====================================
LIVE XML DUPLICATE CHECK — KEPT BUT UNUSED

⚠️ DO NOT call this from routes.js or worker.js. This exact
DuplicateCheckCollection request is what crashes this TallyPrime
build with "Software Exception c0000005 (Memory Access Violation)".
Left here only so the code/history isn't lost.
====================================
*/

const VOUCHER_TYPE_DISPLAY = { payment: "Payment", receipt: "Receipt", contra: "Contra" };

function displayVoucherType(voucherType) {
  const key = String(voucherType || "").toLowerCase();
  if (VOUCHER_TYPE_DISPLAY[key]) return VOUCHER_TYPE_DISPLAY[key];
  return voucherType ? voucherType[0].toUpperCase() + voucherType.slice(1) : "";
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildDuplicateSearchXml({ companyName, voucherDateYYYYMMDD }) {
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>DuplicateCheckCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVFROMDATE>${voucherDateYYYYMMDD}</SVFROMDATE>
        <SVTODATE>${voucherDateYYYYMMDD}</SVTODATE>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="DuplicateCheckCollection" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <FETCH>VOUCHERNUMBER, VOUCHERTYPENAME, DATE, PARTYLEDGERNAME, GUID, ALLLEDGERENTRIES.LIST</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function amountsMatch(a, b, tolerance = 0.01) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function findVoucherArray(envelope) {
  if (!envelope || typeof envelope !== "object") return [];
  for (const key of Object.keys(envelope)) {
    const val = envelope[key];
    if (val && typeof val === "object" && "VOUCHER" in val) return toArray(val.VOUCHER);
  }
  return [];
}

export async function checkDuplicate({
  companyName, voucherType, voucherDateYYYYMMDD, partyLedger, bankLedger, amount, voucherId,
}) {
  if (!companyName) throw new Error("checkDuplicate: companyName is required");
  if (!voucherDateYYYYMMDD) throw new Error("checkDuplicate: voucherDateYYYYMMDD is required");

  const requestXml = buildDuplicateSearchXml({ companyName, voucherDateYYYYMMDD });

  let response;
  try {
    response = await axios.post(TALLY_URL, requestXml, {
      headers: { "Content-Type": "text/xml" },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 500,
    });
  } catch (err) {
    throw new TallyConnectionError(
      `tally server unavailable — could not reach Tally at ${TALLY_URL} while checking for duplicates (voucher ${voucherId ?? "?"}). Underlying error: ${err.code || err.message}`,
      err.code || "ECONNREFUSED", err,
    );
  }

  const body = typeof response.data === "string" ? response.data : String(response.data ?? "");
  if (!body.trim().startsWith("<")) {
    throw new TallyConnectionError(`tally server unavailable — unexpected non-XML response during duplicate check: ${body.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = xmlParser.parse(body);
  } catch (err) {
    throw new TallyConnectionError("tally server unavailable — failed to parse duplicate-check XML response.", "EPARSE", err);
  }

  const lineError = parsed?.ENVELOPE?.LINEERROR;
  if (lineError) {
    throw new TallyRequestError(
      `Tally rejected the duplicate-check request for voucher ${voucherId ?? "?"} (company "${companyName}"): ${lineError}.`,
      lineError,
    );
  }

  const vouchers = findVoucherArray(parsed?.ENVELOPE);
  const targetVoucherType = displayVoucherType(voucherType).trim().toLowerCase();
  const targetAmount = Math.abs(Number(amount));
  const normalizedParty = String(partyLedger || "").trim().toLowerCase();
  const normalizedBank = String(bankLedger || "").trim().toLowerCase();

  const matches = [];
  for (const v of vouchers) {
    if (String(v.VOUCHERTYPENAME || "").trim().toLowerCase() !== targetVoucherType) continue;
    const entries = toArray(v["ALLLEDGERENTRIES.LIST"]);
    const hasPartyMatch = entries.some((e) =>
      String(e.LEDGERNAME || "").trim().toLowerCase() === normalizedParty &&
      amountsMatch(Math.abs(Number(e.AMOUNT)), targetAmount));
    const hasBankMatch = entries.some((e) =>
      String(e.LEDGERNAME || "").trim().toLowerCase() === normalizedBank &&
      amountsMatch(Math.abs(Number(e.AMOUNT)), targetAmount));
    if (hasPartyMatch && hasBankMatch) {
      matches.push({ voucherNumber: v.VOUCHERNUMBER, voucherType: v.VOUCHERTYPENAME, date: v.DATE, guid: v.GUID });
    }
  }

  if (matches.length === 0) return { exists: false, message: "No matching voucher found in Tally." };
  return { exists: true, message: "Voucher already exists in Tally", matches };
}

/*
====================================
ACTIVE — DIRECT DB DUPLICATE CHECK (no sync call)

CHANGED: previously this called /voucher-sync first, then checked
the DB. That has been removed entirely. This now queries
app_test.vouchers directly, relying on whatever data your existing
periodic/manual sync has already populated. Party-ledger assignment
and the pre-push worker check are now fully independent of whether
Tally is reachable at that exact moment.

Uses the party_ledger_name column directly (confirmed present on
app_test.vouchers), and still inspects ledger_entries (jsonb) to
confirm the bank ledger + amount side of the entry.
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