import express from "express";
import db from "../db/index.js";
import multer from "multer";
import xlsx from "xlsx";
import path from "path";
import { spawn } from "child_process";

import { DB_SCHEMA } from "../config/db.js";
import {
  voucherQueue,
  VOUCHER_JOB_OPTIONS,
  getVoucherJobId,
  safeEnqueueVoucher
} from "../queues/voucher.queue.js";
import { formatVoucherDate, checkDuplicateFromDb, validateBankMatchesLedger } from "./voucher.js";
import { suggestLedgersForGroupKeys } from "../services/ledgerEmbedding.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";


const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf") return cb(new Error("PDF_NOT_SUPPORTED"));
    cb(null, true);
  }
});

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

function cleanString(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[A-Z]$/, "")
    .trim();
}

/* ============================================================
   GENERAL BANK-STATEMENT COLUMN MAPPER

   Every known header variant we've seen across bank exports.
   To support a NEW bank format, just add its header text (any
   case, any spacing) to the relevant array below — nothing else
   in this file needs to change.
   ============================================================ */
const HEADER_ALIASES = {
  date: [
    "date", "txn date", "transaction date", "tran date",
    "transaction dt", "value date", "value dt"
  ],
  narration: [
    "narration", "description", "particulars",
    "transaction remarks", "remarks", "transaction particulars"
  ],
  chequeRef: [
    "chq./ref.no.", "chq/ref no.", "chq no", "chq no.",
    "ref no", "ref no.", "cheque number", "chqno", "cheque no",
    "cheque no.",       // IDFC First: "Cheque No." (with trailing period)
    "chq /ref no."      // Kotak Mahindra: "Chq /Ref No."
  ],
  withdrawal: [
    "withdrawal amt.", "withdrawal amt", "debit", "dr",
    "withdrawal amount(inr)", "withdrawal amount"
  ],
  deposit: [
    "deposit amt.", "deposit amt", "credit", "cr",
    "deposit amount(inr)", "deposit amount"
  ],
  balance: [
    "closing balance", "balance", "balance(inr)", "bal"
  ],
  // NEW: banks that report a single Amount column plus a separate
  // Dr/Cr type flag instead of splitting into two amount columns
  // (e.g. Kotak Mahindra's exports)
  amount: ["amount", "transaction amount", "amount(inr)"],
  drCr: ["dr / cr", "dr/cr", "cr/dr", "cr / dr", "type", "transaction type"]
};

// Header names used ONLY to *find* the header row (kept separate from
// HEADER_ALIASES.date since a couple of these, e.g. plain "particulars",
// are too generic to safely double as a date match).
const HEADER_ROW_DETECTORS = [
  ...HEADER_ALIASES.date,
  ...HEADER_ALIASES.withdrawal,
  ...HEADER_ALIASES.deposit
];

function normalizeHeaderKey(key) {
  return String(key || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Re-keys a sheet_to_json row (whose keys are the literal, possibly
// whitespace-padded / inconsistently-cased header text) into a row
// keyed by normalized header text. Done once per row instead of
// normalizing on every lookup.
function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[normalizeHeaderKey(key)] = value;
  }
  return out;
}

// Looks up a field on an already-normalized row using an alias list
// from HEADER_ALIASES. Returns the first non-empty match.
function pickField(normRow, aliasListKey) {
  for (const alias of HEADER_ALIASES[aliasListKey]) {
    const val = normRow[normalizeHeaderKey(alias)];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return null;
}

function findHeaderRowIndex(sheet) {
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  for (let r = range.s.r; r <= Math.min(range.e.r, 30); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[xlsx.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "string") {
        const val = normalizeHeaderKey(cell.v);
        if (HEADER_ROW_DETECTORS.includes(val)) {
          return r;
        }
      }
    }
  }
  return 0;
}

const MONTH_NAME_TO_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function parseDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().split("T")[0];
  if (typeof raw === "number") {
    const date = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return date.toISOString().split("T")[0];
  }

  const str = cleanString(String(raw));

  // Numeric formats: DD/MM/YYYY, DD-MM-YYYY — optional trailing time
  const numMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (numMatch) {
    let [, d, m, y] = numMatch;
    if (y.length === 2) y = "20" + y;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // Month-name formats: DD-Mon-YYYY (e.g. IDFC First: "05-Apr-2025")
  const monMatch = str.match(/^(\d{1,2})[\s\/\-]([A-Za-z]{3,})[\s\/\-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (monMatch) {
    const [, d, monName, yRaw] = monMatch;
    const mNum = MONTH_NAME_TO_NUM[monName.slice(0, 3).toLowerCase()];
    if (mNum) {
      const y = yRaw.length === 2 ? "20" + yRaw : yRaw;
      return `${y}-${String(mNum).padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }

  return null;
}

function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "-") return null;
  if (typeof raw === "number") return raw;
  const num = parseFloat(String(raw).replace(/,/g, "").trim());
  return isNaN(num) ? null : num;
}

// Skip bank separator rows (rows full of *** or ---)
function isSeparatorRow(row) {
  const values = Object.values(row).map((v) =>
    String(v ?? "").trim().replace(/[*\-\s]/g, "")
  );
  return values.every((v) => v === "");
}

/* ===========================
   UNIQUE FILE NAME RESOLVER
=========================== */

async function getUniqueFileName(company_id, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const rootMatch = base.match(/^(.*) \((\d+)\)$/);
  const root = rootMatch ? rootMatch[1] : base;

  const existing = await db.query(
    `SELECT DISTINCT file_name
     FROM ${DB_SCHEMA}.contra_vouchers
     WHERE company_id = $1
       AND file_name LIKE $2`,
    [company_id, `${root}%${ext}`]
  );
  const existingNames = new Set(existing.rows.map((r) => r.file_name));

  if (!existingNames.has(fileName)) return fileName;

  let n = 1;
  let candidate;
  do {
    candidate = `${root} (${n})${ext}`;
    n++;
  } while (existingNames.has(candidate));

  return candidate;
}

/* ===========================
   FALLBACK GROUP KEY EXTRACTOR
=========================== */

function deriveFallbackGroupKey(narration) {
  if (!narration) return null;

  const impsMatch = narration.match(/^(?:IMPS|NEFT|RTGS)-\d+-(.+?)-[A-Z]{3,6}-/i);
  if (impsMatch) {
    return impsMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  const upiMatch = narration.match(/^UPI-(.+?)-[\w.]+@[\w]+-/i);
  if (upiMatch) {
    return upiMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  return null;
}

/* ===========================
   SEMANTIC ENRICHMENT
=========================== */

const SEMANTIC_CLI_TIMEOUT_MS = 15000;

function runSemanticEnrichment(transactions) {
  return new Promise((resolve) => {
    if (!transactions.length) return resolve(transactions);

    const pyFile = path.join(process.cwd(), "src", "python", "semantic_cli.py");
    const python = spawn("python3", [pyFile]);

    let output = "";
    let errorOutput = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.error("semantic_cli timed out after", SEMANTIC_CLI_TIMEOUT_MS, "ms — killing process");
      python.kill();
      finish(transactions.map(() => ({})));
    }, SEMANTIC_CLI_TIMEOUT_MS);

    python.stdout.on("data", (d) => (output += d.toString()));
    python.stderr.on("data", (d) => (errorOutput += d.toString()));

    python.on("close", (code) => {
      if (code !== 0) {
        console.error("semantic_cli failed:", errorOutput);
        return finish(transactions.map(() => ({})));
      }
      try {
        const parsed = JSON.parse(output);
        if (parsed?.error) {
          console.error("semantic_cli error:", parsed.error);
          return finish(transactions.map(() => ({})));
        }
        finish(parsed);
      } catch (e) {
        console.error("semantic_cli parse error:", e.message, output);
        finish(transactions.map(() => ({})));
      }
    });

    python.on("error", (err) => {
      console.error("semantic_cli spawn error:", err.message);
      finish(transactions.map(() => ({})));
    });

    python.stdin.write(JSON.stringify(transactions));
    python.stdin.end();
  });
}

/* ===========================
   DUPLICATE CHECK — DIRECT DB, NO SYNC CALL
=========================== */

async function runDuplicateCheck(voucher) {
  const voucherDateStr =
    voucher.voucher_date instanceof Date
      ? voucher.voucher_date.toISOString().split("T")[0]
      : String(voucher.voucher_date).slice(0, 10);

  let result;
  try {
    result = await checkDuplicateFromDb({
      companyId: voucher.company_id,
      voucherType: voucher.voucher_type,
      voucherDate: voucherDateStr,
      partyLedger: voucher.party_ledger,
      bankLedger: voucher.bank_ledger,
      amount: voucher.amount
    });
  } catch (dbErr) {
    return { tallyUnreachable: true, message: `duplicate check failed: ${dbErr.message}`, voucher };
  }

  const updated = await db.query(
    `UPDATE ${DB_SCHEMA}.contra_vouchers
     SET duplicate_checked = true,
         duplicate_message = $1,
         status = $2
     WHERE id = $3
     RETURNING *`,
    [
      result.exists ? result.message : null,
      result.exists ? "DUPLICATE_FOUND" : "PENDING",
      voucher.id
    ]
  );

  return {
    exists: result.exists,
    message: result.message,
    matches: result.matches,
    voucher: updated.rows[0]
  };
}

/* ===========================
   CREATE VOUCHER (manual)
=========================== */

router.post("/create", async (req, res) => {
  try {
    const {
      company_id, company_name, voucher_type,
      voucher_number, voucher_date, party_ledger,
      bank_ledger, amount, narration,
      instrument_number, transfer_bank
    } = req.body;

    if (!company_id) {
      return res.status(400).json({ success: false, message: "company_id is required" });
    }

    const result = await db.query(
      `INSERT INTO ${DB_SCHEMA}.contra_vouchers (
        company_id, company_name, voucher_type, voucher_number,
        voucher_date, party_ledger, bank_ledger, amount,
        narration, instrument_number, transfer_bank, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'WAITING_LEDGER')
      RETURNING *`,
      [
        company_id, company_name, voucher_type, voucher_number,
        voucher_date, party_ledger, bank_ledger, amount,
        narration, instrument_number, transfer_bank
      ]
    );

    const voucher = result.rows[0];

    if (["FAILED", "failed"].includes(voucher.status)) {
      return res.status(400).json({
        success: false,
        message: voucher.err_message || "Voucher creation failed in Tally",
        data: voucher
      });
    }

    return res.status(202).json({
      success: true,
      message: "Voucher queued for Tally processing",
      data: voucher
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   PROCESS A SINGLE UPLOADED FILE
=========================== */

async function processStatementFile({ file, company_id, company_name, bank_ledger, password }) {
  const originalFileName = file.originalname;
  const fileName = await getUniqueFileName(company_id, originalFileName);
  const wasRenamed = fileName !== originalFileName;

  let workbook;
  try {
    workbook = xlsx.read(file.buffer, {
      type: "buffer",
      cellDates: true,
      password: password || undefined
    });
  } catch (xlsxErr) {
    return {
      file_name: fileName,
      original_file_name: wasRenamed ? originalFileName : undefined,
      renamed: wasRenamed,
      success: false,
      message: "Failed to read Excel file. If it is password protected, provide the correct password."
    };
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // ── Bank/ledger cross-check — BEFORE any row is touched ──
  const bankCheck = validateBankMatchesLedger(sheet, bank_ledger, xlsx.utils);
  if (!bankCheck.ok) {
    return {
      file_name: fileName,
      original_file_name: wasRenamed ? originalFileName : undefined,
      renamed: wasRenamed,
      success: false,
      bank_mismatch: true,
      detected_bank: bankCheck.detected,
      expected_bank: bankCheck.expected,
      message: bankCheck.message
    };
  }
  const headerRowIndex = findHeaderRowIndex(sheet);

  let rawRows = xlsx.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
    range: headerRowIndex
  });

  rawRows = rawRows.filter((row) => !isSeparatorRow(row));

  if (!rawRows.length) {
    return {
      file_name: fileName,
      original_file_name: wasRenamed ? originalFileName : undefined,
      renamed: wasRenamed,
      success: false,
      message: "No data rows found in Excel"
    };
  }

  // Normalize every raw row ONCE up front so every lookup below goes
  // through the alias table instead of a hardcoded bracket key. This is
  // what makes the parser bank-agnostic — see HEADER_ALIASES above.
  const normalizedRows = rawRows.map(normalizeRow);

  const narrationInputs = normalizedRows.map((normRow) => ({
    narration: String(pickField(normRow, "narration") ?? "").trim()
  }));

  const enriched = await runSemanticEnrichment(narrationInputs);

  const inserted = [];
  const transactions = [];

  for (const [i, row] of rawRows.entries()) {
    const normRow = normalizedRows[i];

    let withdrawalAmt = parseAmount(pickField(normRow, "withdrawal"));
    let depositAmt = parseAmount(pickField(normRow, "deposit"));

    // Fallback for banks using one Amount column + a Dr/Cr flag
    // instead of separate debit/credit columns
    if (withdrawalAmt === null && depositAmt === null) {
      const combinedAmt = parseAmount(pickField(normRow, "amount"));
      const flag = String(pickField(normRow, "drCr") ?? "").trim().toUpperCase();
      if (combinedAmt !== null && flag) {
        if (flag.startsWith("D")) withdrawalAmt = combinedAmt;
        else if (flag.startsWith("C")) depositAmt = combinedAmt;
      }
    }

    if (withdrawalAmt === null && depositAmt === null) continue;

    const txnDate = parseDate(pickField(normRow, "date"));
    if (!txnDate) continue;

    const narration = String(pickField(normRow, "narration") ?? "").trim() || null;

    const merchantName = enriched[i]?.merchant_name || null;
    let groupKey = enriched[i]?.group_key || null;

    if (!groupKey || groupKey.toLowerCase() === "unknown") {
      const fallbackKey = deriveFallbackGroupKey(narration);
      if (fallbackKey) {
        groupKey = fallbackKey;
      }
    }

    const rawRef = pickField(normRow, "chequeRef") ?? "";
    const chequeRef = cleanString(rawRef) || null;

    transactions.push({
      transaction_date: String(pickField(normRow, "date") ?? "").trim(),
      value_date: String(
        normRow["value dt"] ?? normRow["value date"] ?? pickField(normRow, "date") ?? ""
      ).trim(),
      narration: narration || "",
      cheque_ref: chequeRef || "",
      withdrawal: withdrawalAmt !== null ? String(withdrawalAmt) : "",
      deposit: depositAmt !== null ? String(depositAmt) : "",
      balance: String(pickField(normRow, "balance") ?? "").trim(),
      merchant_name: merchantName || "",
      group_key: groupKey || ""
    });

    if (withdrawalAmt !== null && withdrawalAmt > 0) {
      const existingDebit = await db.query(
        `SELECT id, status FROM ${DB_SCHEMA}.contra_vouchers
         WHERE company_id = $1 AND bank_ledger = $2 AND file_name = $3
           AND voucher_date = $4 AND amount = $5
           AND debit_credit = 'DEBIT' AND narration IS NOT DISTINCT FROM $6`,
        [company_id, bank_ledger, fileName, txnDate, withdrawalAmt, narration]
      );

      if (existingDebit.rows.length > 0) {
        const ex = existingDebit.rows[0];
        if (ex.status === 'FAILED') {
          const r = await db.query(
            `UPDATE ${DB_SCHEMA}.contra_vouchers
             SET status = 'WAITING_LEDGER', err_message = NULL,
                 instrument_number = $1, voucher_type = NULL, party_ledger = NULL
             WHERE id = $2 RETURNING *`,
            [chequeRef, ex.id]
          );
          inserted.push({ ...r.rows[0], _action: 'reset' });
        } else {
          inserted.push({ ...ex, _action: 'skipped' });
        }
      } else {
        const r = await db.query(
          `INSERT INTO ${DB_SCHEMA}.contra_vouchers
           (company_id, company_name, voucher_date, bank_ledger,
            amount, narration, instrument_number,
            debit_credit, voucher_type, party_ledger, status,
            statement_password, file_name, merchant_name, group_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'DEBIT',NULL,NULL,'WAITING_LEDGER',$8,$9,$10,$11)
           RETURNING *`,
          [company_id, company_name, txnDate, bank_ledger,
           withdrawalAmt, narration, chequeRef, password || null, fileName,
           merchantName, groupKey]
        );
        inserted.push({ ...r.rows[0], _action: 'inserted' });
      }
    }

    if (depositAmt !== null && depositAmt > 0) {
      const existingCredit = await db.query(
        `SELECT id, status FROM ${DB_SCHEMA}.contra_vouchers
         WHERE company_id = $1 AND bank_ledger = $2 AND file_name = $3
           AND voucher_date = $4 AND amount = $5
           AND debit_credit = 'CREDIT' AND narration IS NOT DISTINCT FROM $6`,
        [company_id, bank_ledger, fileName, txnDate, depositAmt, narration]
      );

      if (existingCredit.rows.length > 0) {
        const ex = existingCredit.rows[0];
        if (ex.status === 'FAILED') {
          const r = await db.query(
            `UPDATE ${DB_SCHEMA}.contra_vouchers
             SET status = 'WAITING_LEDGER', err_message = NULL,
                 instrument_number = $1, voucher_type = NULL, party_ledger = NULL
             WHERE id = $2 RETURNING *`,
            [chequeRef, ex.id]
          );
          inserted.push({ ...r.rows[0], _action: 'reset' });
        } else {
          inserted.push({ ...ex, _action: 'skipped' });
        }
      } else {
        const r = await db.query(
          `INSERT INTO ${DB_SCHEMA}.contra_vouchers
           (company_id, company_name, voucher_date, bank_ledger,
            amount, narration, instrument_number,
            debit_credit, voucher_type, party_ledger, status,
            statement_password, file_name, merchant_name, group_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'CREDIT',NULL,NULL,'WAITING_LEDGER',$8,$9,$10,$11)
           RETURNING *`,
          [company_id, company_name, txnDate, bank_ledger,
           depositAmt, narration, chequeRef, password || null, fileName,
           merchantName, groupKey]
        );
        inserted.push({ ...r.rows[0], _action: 'inserted' });
      }
    }
  }

  if (!inserted.length) {
    return {
      file_name: fileName,
      original_file_name: wasRenamed ? originalFileName : undefined,
      renamed: wasRenamed,
      success: false,
      message: "No valid transaction rows found in the file"
    };
  }

  const newRows     = inserted.filter(v => v._action === 'inserted');
  const skippedRows = inserted.filter(v => v._action === 'skipped');
  const resetRows   = inserted.filter(v => v._action === 'reset');

  const allDates = inserted.map(v => v.voucher_date).filter(Boolean).sort();

  return {
    file_name: fileName,
    original_file_name: wasRenamed ? originalFileName : undefined,
    renamed: wasRenamed,
    success: true,
    message: `${newRows.length} new, ${skippedRows.length} skipped, ${resetRows.length} reset.` +
      (wasRenamed ? ` (saved as "${fileName}" — a file named "${originalFileName}" already existed for this company)` : ""),
    bank_ledger,
    start_date: allDates[0] || null,
    end_date: allDates[allDates.length - 1] || null,
    total: inserted.length,
    inserted_count: newRows.length,
    skipped_count: skippedRows.length,
    reset_count: resetRows.length,
    debit_count: inserted.filter(v => v.debit_credit === "DEBIT").length,
    credit_count: inserted.filter(v => v.debit_credit === "CREDIT").length,
    data: inserted,
    transactions
  };
}

/* ===========================
   UPLOAD BANK STATEMENT(S) (EXCEL)
=========================== */

router.post(
  "/upload-statement",
  (req, res, next) => {
    upload.array("files")(req, res, (err) => {
      if (err?.message === "PDF_NOT_SUPPORTED") {
        return res.status(415).json({
          success: false,
          message: "PDF files are not supported. Please upload an Excel file (.xls or .xlsx)."
        });
      }
      if (err) return res.status(400).json({ success: false, message: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const { company_id, company_name, bank_ledger, password } = req.body;

      if (!req.files || !req.files.length) {
        return res.status(400).json({ success: false, message: "At least one Excel file is required" });
      }
      if (!company_id || !company_name || !bank_ledger) {
        return res.status(400).json({
          success: false,
          message: "company_id, company_name and bank_ledger are required"
        });
      }

      const results = [];
      for (const file of req.files) {
        try {
          const outcome = await processStatementFile({
            file, company_id, company_name, bank_ledger, password
          });
          results.push(outcome);
        } catch (fileErr) {
          console.error(`upload-statement error processing "${file.originalname}":`, fileErr);
          results.push({
            file_name: file.originalname,
            success: false,
            message: fileErr.message
          });
        }
      }

      const anySucceeded = results.some((r) => r.success);

      return res.status(anySucceeded ? 201 : 400).json({
        success: anySucceeded,
        file_count: results.length,
        files: results
      });

    } catch (err) {
      console.error("upload-statement error:", err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* ===========================
   GET STATEMENT DETAILS
=========================== */

router.get("/statement-details", async (req, res) => {
  try {
    const { company_id } = req.query;

    if (!company_id) {
      return res.status(400).json({ success: false, message: "company_id is required" });
    }

    const result = await db.query(
      `SELECT
        file_name,
        bank_ledger,
        TO_CHAR(MIN(voucher_date), 'DD-Mon-YYYY') AS start_date,
        TO_CHAR(MAX(voucher_date), 'DD-Mon-YYYY') AS end_date
       FROM ${DB_SCHEMA}.contra_vouchers
       WHERE company_id = $1
         AND file_name IS NOT NULL
       GROUP BY file_name, bank_ledger
       ORDER BY MAX(created_at) DESC`,
      [company_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "No statement found for this company"
      });
    }

    const row = result.rows[0];

    return res.status(200).json({
      success: true,
      data: {
        file_name:   row.file_name,
        bank_ledger: row.bank_ledger,
        start_date:  row.start_date,
        end_date:    row.end_date
      }
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   GET STATEMENT TRANSACTIONS (AI Suggestion shape)
=========================== */

router.get("/statement-transactions", async (req, res) => {
  try {
    const { company_id, file_name } = req.query;

    if (!company_id) {
      return res.status(400).json({
        success: false,
        message: "company_id is required"
      });
    }

    const params = [company_id];
    let fileFilterClause = "";
    if (file_name) {
      fileFilterClause = "AND file_name = $2";
      params.push(file_name);
    }

    const result = await db.query(
      `SELECT
        id,
        status,
        voucher_date,
        narration,
        instrument_number,
        amount,
        debit_credit,
        merchant_name,
        group_key,
        file_name,
        bank_ledger
       FROM ${DB_SCHEMA}.contra_vouchers
       WHERE company_id = $1
         AND file_name IS NOT NULL
         ${fileFilterClause}
       ORDER BY
         file_name ASC,
         COALESCE(group_key, 'zzz_ungrouped') ASC,
         voucher_date ASC,
         id ASC`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: file_name
          ? `No transactions found for file "${file_name}"`
          : "No statement found for this company"
      });
    }

    const toTxn = (r) => ({
      id: r.id,
      status: r.status,
      transaction_date: r.voucher_date
        ? new Date(r.voucher_date).toISOString().split("T")[0]
        : "",
      narration: r.narration || "",
      cheque_ref: r.instrument_number || "",
      withdrawal: r.debit_credit === "DEBIT" ? String(r.amount) : "",
      deposit: r.debit_credit === "CREDIT" ? String(r.amount) : "",
      merchant_name: r.merchant_name || "",
      group_key: r.group_key || "",
      file_name: r.file_name
    });

    const fileMap = new Map();
    for (const r of result.rows) {
      if (!fileMap.has(r.file_name)) {
        fileMap.set(r.file_name, { file_name: r.file_name, bank_ledger: r.bank_ledger, transactions: [] });
      }
      fileMap.get(r.file_name).transactions.push(toTxn(r));
    }
    const files = [...fileMap.values()].map((f) => ({
      ...f,
      total: f.transactions.length
    }));

    const groupsMap = new Map();
    for (const r of result.rows) {
      const groupKey = r.group_key || "__ungrouped__";
      const key = `${r.file_name}||${groupKey}`;

      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          group_key: r.group_key || null,
          merchant_name: r.merchant_name || null,
          file_name: r.file_name,
          count: 0,
          total_withdrawal: 0,
          total_deposit: 0,
          transactions: [],
          distinctNarrations: new Set(),
          seenRowKeys: new Set()
        });
      }
      const bucket = groupsMap.get(key);
      const rowKey = [
        (r.narration || "").trim().toLowerCase(),
        r.instrument_number || "",
        r.debit_credit,
        Number(r.amount),
        r.voucher_date ? new Date(r.voucher_date).toISOString().split("T")[0] : ""
      ].join("|");

      bucket.distinctNarrations.add((r.narration || "").trim().toLowerCase());

      if (bucket.seenRowKeys.has(rowKey)) continue;
      bucket.seenRowKeys.add(rowKey);

      const txn = toTxn(r);
      bucket.transactions.push(txn);
      bucket.count += 1;
      if (r.debit_credit === "DEBIT") bucket.total_withdrawal += Number(r.amount) || 0;
      if (r.debit_credit === "CREDIT") bucket.total_deposit += Number(r.amount) || 0;
    }

    const groups = [...groupsMap.values()]
      .filter(g => g.group_key !== null && g.count > 1 && g.distinctNarrations.size > 1)
      .map(({ distinctNarrations, seenRowKeys, ...rest }) => rest)
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({
      success: true,
      file_count: files.length,
      files,
      group_count: groups.length,
      groups
    });

  } catch (err) {
    console.error("statement-transactions error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* ===========================
   SUGGEST PARTY LEDGER
=========================== */

router.get("/suggest-party-ledger", async (req, res) => {
  try {
    const { company_name, narration } = req.query;

    if (!company_name) {
      return res.status(400).json({
        success: false,
        message: "company_name is required"
      });
    }

    const trimmedNarration = narration && narration.trim() ? narration.trim() : null;
    const normalizedNarration = trimmedNarration ? trimmedNarration.toLowerCase() : null;
    const narrationPattern = trimmedNarration ? `%${trimmedNarration}%` : null;

    const vouchersBranch = narrationPattern
      ? `
        UNION ALL

        SELECT
          party_ledger_name AS party_ledger,
          narration,
          voucher_date
        FROM ${DB_SCHEMA}.vouchers
        WHERE company_name = $1
          AND party_ledger_name IS NOT NULL
          AND narration ILIKE $2
      `
      : "";

    const result = await db.query(
      `
      WITH combined AS (
        SELECT party_ledger, narration, voucher_date
        FROM ${DB_SCHEMA}.contra_vouchers
        WHERE company_name = $1
          AND party_ledger IS NOT NULL
          AND status = 'SUCCESS'
        ${vouchersBranch}
      )
      SELECT
        party_ledger,
        COUNT(*) AS usage_count,
        MAX(voucher_date) AS last_used,
        MAX(
          CASE
            WHEN $3::text IS NOT NULL AND LOWER(TRIM(narration)) = $3 THEN 2
            WHEN $2::text IS NOT NULL AND narration ILIKE $2 THEN 1
            ELSE 0
          END
        ) AS match_tier
      FROM combined
      GROUP BY party_ledger
      ORDER BY match_tier DESC, usage_count DESC, last_used DESC
      LIMIT 5
      `,
      [company_name, narrationPattern, normalizedNarration]
    );

    if (!result.rows.length) {
      return res.status(200).json({
        success: true,
        suggested_party_ledger: null,
        suggestions: [],
        message: "No prior vouchers found for this company yet — no suggestion available."
      });
    }

    const suggestions = result.rows.map((r) => ({
      party_ledger: r.party_ledger,
      usage_count: Number(r.usage_count),
      last_used: r.last_used,
      match_reason:
        Number(r.match_tier) === 2 ? "this exact narration was used before" :
        Number(r.match_tier) === 1 ? "similar narration" :
        "commonly used for this company"
    }));

    return res.status(200).json({
      success: true,
      suggested_party_ledger: suggestions[0].party_ledger,
      suggestions
    });

  } catch (err) {
    console.error("suggest-party-ledger error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   SUGGEST PARTY LEDGER BY GROUP KEY (embedding similarity)
=========================== */

router.get("/suggest-ledger-by-group-key", async (req, res) => {
  try {
    const { company_name, group_key } = req.query;

    if (!company_name || !group_key) {
      return res.status(400).json({
        success: false,
        message: "company_name and group_key are required"
      });
    }

    const suggestionMap = await suggestLedgersForGroupKeys(company_name, [group_key]);
    const suggestion = suggestionMap.get(group_key) || null;

    return res.status(200).json({
      success: true,
      suggested: !!suggestion?.suggested,
      ledger_name: suggestion?.suggested ? suggestion.ledger_name : null,
      similarity: suggestion?.suggested ? suggestion.similarity : null
    });

  } catch (err) {
    console.error("suggest-ledger-by-group-key error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   GET WAITING LEDGER VOUCHERS
=========================== */

router.get("/waiting-ledger", async (req, res) => {
  try {
    const { company_id, file_name } = req.query;

    if (!company_id) {
      return res.status(400).json({ success: false, message: "company_id is required" });
    }

    const params = [company_id];
    let fileFilterClause = "";
    if (file_name) {
      fileFilterClause = "AND file_name = $2";
      params.push(file_name);
    }

    const result = await db.query(
      `SELECT
        id, company_id, company_name, voucher_type, voucher_number,
        voucher_date, bank_ledger, amount, narration,
        instrument_number, debit_credit, status, created_at,
        merchant_name, group_key
       FROM ${DB_SCHEMA}.contra_vouchers
       WHERE status = 'WAITING_LEDGER'
         AND company_id = $1
         ${fileFilterClause}
       ORDER BY voucher_date ASC, id ASC`,
      params
    );

    const rows = result.rows;
    const companyName = rows[0]?.company_name;

    let suggestionMap = new Map();
    if (companyName) {
      const groupKeys = rows.map((r) => r.group_key);
      suggestionMap = await suggestLedgersForGroupKeys(companyName, groupKeys);
    }

    const data = rows.map((r) => {
      const suggestion = r.group_key ? suggestionMap.get(r.group_key) : null;
      return {
        ...r,
        suggested_party_ledger: suggestion?.suggested ? suggestion.ledger_name : null,
        suggestion_similarity: suggestion?.suggested ? suggestion.similarity : null
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   GET ALL VOUCHERS
=========================== */

router.get("/all", async (req, res) => {
  try {
    const { company_id } = req.query;
    const result = await db.query(
      `SELECT * FROM ${DB_SCHEMA}.contra_vouchers
       ${company_id ? "WHERE company_id = $1" : ""}
       ORDER BY id DESC`,
      company_id ? [company_id] : []
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   GET VOUCHERS BY PARTY LEDGER + VOUCHER TYPE
=========================== */

router.get("/filter", async (req, res) => {
  try {
    const { company_id, party_ledger, voucher_type } = req.query;

    if (!company_id) {
      return res.status(400).json({ success: false, message: "company_id is required" });
    }

    const conditions = ["company_id = $1"];
    const values = [company_id];
    let idx = 2;

    if (party_ledger) {
      conditions.push(`party_ledger ILIKE $${idx++}`);
      values.push(`%${party_ledger}%`);
    }

    if (voucher_type) {
      const allowed = ["payment", "receipt", "contra"];
      if (!allowed.includes(voucher_type.toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: "Invalid voucher_type. Allowed: payment, receipt, contra"
        });
      }
      conditions.push(`voucher_type = $${idx++}`);
      values.push(voucher_type.toLowerCase());
    }

    const result = await db.query(
      `SELECT
        id, company_id, company_name,
        voucher_type, voucher_number, voucher_date,
        bank_ledger, party_ledger, amount,
        narration, instrument_number, debit_credit,
        status, created_at, merchant_name, group_key
       FROM ${DB_SCHEMA}.contra_vouchers
       WHERE ${conditions.join(" AND ")}
       ORDER BY voucher_date DESC, id DESC`,
      values
    );

    return res.status(200).json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   ASSIGN party_ledger + voucher_type — CORE LOGIC (shared)

   ★ CHANGED: the UPDATE now also writes force_push = forcePushFlag.
   Previously forcePushFlag only skipped the duplicate check on THIS
   request — it never persisted anything, so when the job actually
   ran on the worker, voucher.force_push was still falsy and the
   worker re-ran checkDuplicateFromDb from scratch, undoing the force.
   Explicitly writing it either way (true OR false) also means a
   voucher that was previously force-pushed and later bounces back to
   WAITING_LEDGER/FAILED doesn't silently keep a stale force_push=true.
=========================== */
async function assignPartyLedger(vouchers, forcePushFlag, userId) {
  const allowed = ["payment", "receipt", "contra"];

  const queued = [];
  const duplicates = [];
  const tallyUnreachable = [];
  const notFound = [];
  const invalid = [];

  for (const v of vouchers) {
    if (!v.id || !v.party_ledger || !v.voucher_type) {
      invalid.push({ id: v.id ?? null, reason: "Missing id, party_ledger, or voucher_type", input: v });
      continue;
    }

    if (!Number.isInteger(Number(v.id))) {
      invalid.push({ id: v.id, reason: `id must be a numeric voucher id, got "${v.id}"` });
      continue;
    }

    if (!allowed.includes(v.voucher_type.toLowerCase())) {
      invalid.push({ id: v.id, reason: `Invalid voucher_type "${v.voucher_type}". Allowed: payment, receipt, contra` });
      continue;
    }

    const isContra = v.voucher_type.toLowerCase() === "contra";

      const result = await db.query(
    `UPDATE ${DB_SCHEMA}.contra_vouchers
     SET
       party_ledger  = $1,
       voucher_type  = $2,
       transfer_bank = $3,
       force_push    = $4,
       user_id       = $5,
       status        = 'PENDING'
     WHERE id = $6
       AND status IN ('WAITING_LEDGER', 'FAILED')
     RETURNING *`,
    [v.party_ledger, v.voucher_type.toLowerCase(),
     isContra ? v.party_ledger : null, forcePushFlag, userId, v.id]
  );

    if (result.rows.length === 0) {
      notFound.push(v.id);
      continue;
    }

    let voucher = result.rows[0];

    if (!forcePushFlag) {
      const duplicateOutcome = await runDuplicateCheck(voucher);

      if (duplicateOutcome.tallyUnreachable) {
        await db.query(
          `UPDATE ${DB_SCHEMA}.contra_vouchers SET status = 'WAITING_LEDGER' WHERE id = $1`,
          [v.id]
        );
        tallyUnreachable.push({ id: v.id, message: duplicateOutcome.message });
        continue;
      }

      if (duplicateOutcome.exists) {
        duplicates.push({
          id: v.id,
          message: duplicateOutcome.message,
          matches: duplicateOutcome.matches
        });
        continue;
      }

      voucher = duplicateOutcome.voucher;
    }

    await safeEnqueueVoucher(v.id);
    queued.push(v.id);
  }

  if (queued.length === 0 && duplicates.length === 0 &&
      tallyUnreachable.length === 0 && invalid.length === vouchers.length &&
      notFound.length === 0) {
    return {
      status: 400,
      body: { success: false, message: "All items in the batch were invalid", invalid }
    };
  }

  if (queued.length === 0 && duplicates.length === 0 &&
      tallyUnreachable.length === 0 && invalid.length === 0 &&
      notFound.length === vouchers.length) {
    return {
      status: 404,
      body: { success: false, message: "No matching WAITING_LEDGER or FAILED vouchers found" }
    };
  }

  if (vouchers.length === 1 && duplicates.length === 1) {
    return {
      status: 409,
      body: {
        success: false,
        duplicate: true,
        message: duplicates[0].message,
        matches: duplicates[0].matches,
        nextSteps: {
          confirmPush: `POST /voucher/${duplicates[0].id}/confirm-push`,
          cancelPush: `POST /voucher/${duplicates[0].id}/cancel-push`
        }
      }
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `${queued.length} queued, ${duplicates.length} duplicate(s) found, ` +
        `${tallyUnreachable.length} skipped (duplicate-check error), ` +
        `${notFound.length} not found, ${invalid.length} invalid`,
      queued,
      duplicates,
      tallyUnreachable,
      notFound,
      invalid,
      ...(duplicates.length
        ? { nextSteps: "For each id in `duplicates`, call POST /voucher/:id/confirm-push or POST /voucher/:id/cancel-push" }
        : {})
    }
  };
}

/* ===========================
   ASSIGN party_ledger + voucher_type (single OR bulk) — CANONICAL ROUTE
=========================== */
router.put("/party-ledger", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ success: false, message: "No profile found for this account" });
    }

    const forcePushFlag = req.body.forcePush === true;
    const vouchers = Array.isArray(req.body.vouchers)
      ? req.body.vouchers
      : [{ id: req.body.id, party_ledger: req.body.party_ledger, voucher_type: req.body.voucher_type }];

    if (!vouchers.length || !vouchers[0]?.id) {
      return res.status(400).json({
        success: false,
        message: "Provide either { id, party_ledger, voucher_type } or { vouchers: [...] }"
      });
    }

    const { status, body } = await assignPartyLedger(vouchers, forcePushFlag, userId);
    return res.status(status).json(body);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
/* ===========================
   BACKWARD-COMPATIBLE ALIASES (temporary)
=========================== */
router.put("/bulk-party-ledger", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "No profile found for this account"
      });
    }

    const forcePushFlag = req.body.forcePush === true;
    const vouchers = Array.isArray(req.body.vouchers)
      ? req.body.vouchers
      : [];

    if (!vouchers.length) {
      return res.status(400).json({
        success: false,
        message:
          "vouchers[] array is required. Each item needs: id, party_ledger, voucher_type"
      });
    }

    const { status, body } = await assignPartyLedger(
      vouchers,
      forcePushFlag,
      userId
    );

    return res.status(status).json(body);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

router.put("/:id/party-ledger", async (req, res) => {
  try {
    const forcePushFlag = req.body.forcePush === true;
    const vouchers = [{
      id: Number(req.params.id),
      party_ledger: req.body.party_ledger,
      voucher_type: req.body.voucher_type
    }];

    const { status, body } = await assignPartyLedger(vouchers, forcePushFlag);
    return res.status(status).json(body);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   CONFIRM PUSH

   ★ CHANGED: now also sets force_push = true in the same UPDATE that
   flips status → PENDING. This is the actual fix for the infinite
   duplicate loop — without it, the worker re-ran checkDuplicateFromDb
   once the queued job started and flipped the voucher straight back
   to DUPLICATE_FOUND.
=========================== */

router.post("/:id/confirm-push", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) {
      return res.status(404).json({ success: false, message: "No profile found for this account" });
    }

    const voucherId = Number(req.params.id);

    const result = await db.query(
      `UPDATE ${DB_SCHEMA}.contra_vouchers
       SET status = 'PENDING',
           force_push = true,
           user_id = $2
       WHERE id = $1
         AND status IN ('WAITING_LEDGER', 'FAILED', 'DUPLICATE_FOUND')
       RETURNING *`,
      [voucherId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Voucher not found or not currently awaiting duplicate confirmation"
      });
    }

    const enqueueResult = await safeEnqueueVoucher(voucherId);

    return res.status(202).json({
      success: true,
      message: "Push confirmed — voucher queued for Tally",
      data: result.rows[0],
      queue: enqueueResult
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   CANCEL PUSH
=========================== */

router.post("/:id/cancel-push", async (req, res) => {
  try {
    const voucherId = Number(req.params.id);

    const jobId = getVoucherJobId(voucherId);
    const existingJob = await voucherQueue.getJob(jobId);

    let jobRemoved = false;
    if (existingJob) {
      const state = await existingJob.getState();
      if (state !== "active") {
        await existingJob.remove();
        jobRemoved = true;
      }
    }

    const result = await db.query(
      `UPDATE ${DB_SCHEMA}.contra_vouchers
       SET status = 'CANCELLED'
       WHERE id = $1
         AND status IN ('DUPLICATE_FOUND', 'PENDING', 'WAITING_LEDGER')
       RETURNING *`,
      [voucherId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Voucher not found or cannot be cancelled in its current state"
      });
    }

    return res.status(200).json({
      success: true,
      jobRemoved,
      data: result.rows[0]
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   GET SINGLE VOUCHER
=========================== */

router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM ${DB_SCHEMA}.contra_vouchers WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Voucher not found" });
    }

    return res.status(200).json({ success: true, data: result.rows[0] });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;