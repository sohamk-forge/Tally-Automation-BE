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

import { formatVoucherDate, checkDuplicateFromDb } from "./voucher.js";
import { suggestLedgersForGroupKeys } from "../services/ledgerEmbedding.js";

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

function findHeaderRowIndex(sheet) {
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[xlsx.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "string") {
        const val = cell.v.trim().toLowerCase();
        if (val === "date" || val === "txn date" || val === "transaction date") {
          return r;
        }
      }
    }
  }
  return 0;
}

function parseDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().split("T")[0];
  if (typeof raw === "number") {
    const date = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return date.toISOString().split("T")[0];
  }
  const str = cleanString(String(raw));
  const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (match) {
    let [, d, m, y] = match;
    if (y.length === 2) y = "20" + y;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
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

   Replaces the old "reject if this file_name already exists for this
   company" behavior. Instead of blocking a re-upload of a
   same-named file, this finds a free " (n)" variant of the name for
   this company_id, so the new upload is inserted, processed, and
   returned as its OWN distinct file_name/section — it is never
   merged into the rows/groups of the existing file with that name.

   Any trailing " (n)" already present on the incoming name is
   stripped first to find the "root" name, so repeated re-uploads of
   the same source file keep incrementing from the same root instead
   of stacking suffixes like "Statement (1) (1).xls".
=========================== */

async function getUniqueFileName(company_id, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const rootMatch = base.match(/^(.*) \((\d+)\)$/);
  const root = rootMatch ? rootMatch[1] : base;

  const existing = await db.query(
    `SELECT DISTINCT file_name
     FROM app_test.contra_vouchers
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

   Used whenever the semantic enrichment script (semantic_cli.py)
   couldn't identify a known merchant and returned "unknown"/null.
   This is common for person-to-person IMPS/NEFT/UPI transfers, since
   those scripts are usually built to recognize known merchant/brand
   name patterns, not individual names.

   Extracts the payer/payee name segment sitting between the
   transaction reference and the bank code (IMPS/NEFT/RTGS), or
   between "UPI-" and the "@bank" handle (UPI), so transfers to/from
   the same person still cluster together under a stable group_key
   instead of every such transaction collapsing into one blanket
   "unknown" bucket.

   NOTE: this is a best-effort fallback, not a replacement for proper
   semantic enrichment — it only parses the common bank narration
   shapes below. If the narration doesn't match either pattern, it
   returns null and the original "unknown" value is kept as-is.
=========================== */

function deriveFallbackGroupKey(narration) {
  if (!narration) return null;

  // Matches: IMPS-<digits>-<NAME SEGMENT>-<BANKCODE>-...
  //      or: NEFT-<digits>-<NAME SEGMENT>-<BANKCODE>-...
  //      or: RTGS-<digits>-<NAME SEGMENT>-<BANKCODE>-...
  const impsMatch = narration.match(/^(?:IMPS|NEFT|RTGS)-\d+-(.+?)-[A-Z]{3,6}-/i);
  if (impsMatch) {
    return impsMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  // Matches: UPI-<NAME SEGMENT>-<vpa>@<bank>-...
  const upiMatch = narration.match(/^UPI-(.+?)-[\w.]+@[\w]+-/i);
  if (upiMatch) {
    return upiMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
  }

  return null; // couldn't parse a name segment — leave as unknown
}

/* ===========================
   SEMANTIC ENRICHMENT (replaces the old :8000 FastAPI service)
=========================== */

function runSemanticEnrichment(transactions) {
  return new Promise((resolve) => {
    if (!transactions.length) return resolve(transactions);

    const pyFile = path.join(process.cwd(), "src", "python", "semantic_cli.py");
    const python = spawn("python", [pyFile]);

    let output = "";
    let errorOutput = "";

    python.stdout.on("data", (d) => (output += d.toString()));
    python.stderr.on("data", (d) => (errorOutput += d.toString()));

    python.on("close", (code) => {
      if (code !== 0) {
        console.error("semantic_cli failed:", errorOutput);
        return resolve(transactions.map(() => ({}))); // fail-open
      }
      try {
        const parsed = JSON.parse(output);
        if (parsed?.error) {
          console.error("semantic_cli error:", parsed.error);
          return resolve(transactions.map(() => ({})));
        }
        resolve(parsed);
      } catch (e) {
        console.error("semantic_cli parse error:", e.message, output);
        resolve(transactions.map(() => ({})));
      }
    });

    python.on("error", (err) => {
      console.error("semantic_cli spawn error:", err.message);
      resolve(transactions.map(() => ({})));
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
    `UPDATE app_test.contra_vouchers
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

   Extracted from the old /upload-statement handler so that each
   uploaded file — when multiple are sent in one request — can be
   parsed, enriched, and inserted independently, and returned as its
   own review section keyed by file_name.

   CHANGED: a same-named file is no longer rejected as
   "already_exists". Instead, getUniqueFileName() resolves a free
   " (n)" variant for this company_id, and that variant is used for
   every insert/return below. Because every downstream query that
   groups by file_name (statement-details, statement-transactions,
   waiting-ledger, duplicate checks, etc.) keys off this exact
   file_name column, this upload always lands in its own section and
   is never merged into the previous file's rows or groups.
=========================== */

async function processStatementFile({ file, company_id, company_name, bank_ledger, password }) {
  const originalFileName = file.originalname;

      const existingFile = await db.query(
        `SELECT
          file_name,
          bank_ledger,
          TO_CHAR(MIN(voucher_date), 'DD-Mon-YYYY') AS start_date,
          TO_CHAR(MAX(voucher_date), 'DD-Mon-YYYY') AS end_date,
          COUNT(*) AS total_rows
         FROM ${DB_SCHEMA}.contra_vouchers
         WHERE company_id = $1
           AND file_name = $2
           AND file_name IS NOT NULL
         GROUP BY file_name, bank_ledger`,
        [company_id, fileName]
      );

  if (existingFile.rows.length > 0) {
    return {
      file_name: fileName,
      success: false,
      already_exists: true,
      message: `This file "${fileName}" has already been uploaded.`,
      data: existingFile.rows[0]
    };
  }

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

  const narrationInputs = rawRows.map((row) => ({
    narration: String(
      row["Narration"] ?? row["Description"] ?? row["Particulars"] ?? ""
    ).trim()
  }));

  const enriched = await runSemanticEnrichment(narrationInputs);

  const inserted = [];
  const transactions = [];

  for (const [i, row] of rawRows.entries()) {
    const withdrawalAmt = parseAmount(
      row["Withdrawal Amt."] ?? row["Withdrawal Amt"] ?? row["Debit"] ?? row["DR"]
    );
    const depositAmt = parseAmount(
      row["Deposit Amt."] ?? row["Deposit Amt"] ?? row["Credit"] ?? row["CR"]
    );

    if (withdrawalAmt === null && depositAmt === null) continue;

    const txnDate = parseDate(
      row["Date"] ?? row["Txn Date"] ?? row["Transaction Date"]
    );
    if (!txnDate) continue;

    const narration = String(
      row["Narration"] ?? row["Description"] ?? row["Particulars"] ?? ""
    ).trim() || null;

    const merchantName = enriched[i]?.merchant_name || null;
    let groupKey = enriched[i]?.group_key || null;

    // Fallback group_key derivation. If the Python script returned
    // nothing, or literally "unknown"/"UNKNOWN", try to parse a stable
    // payer/payee name segment out of the narration itself for common
    // transfer-type narrations (IMPS/NEFT/RTGS/UPI).
    if (!groupKey || groupKey.toLowerCase() === "unknown") {
      const fallbackKey = deriveFallbackGroupKey(narration);
      if (fallbackKey) {
        groupKey = fallbackKey;
      }
    }

    const rawRef = row["Chq./Ref.No."] ?? row["Chq/Ref No."] ?? row["Chq No"] ?? row["Ref No"] ?? "";
    const chequeRef = cleanString(rawRef) || null;

    transactions.push({
      transaction_date: String(row["Date"] ?? row["Txn Date"] ?? row["Transaction Date"] ?? "").trim(),
      value_date: String(row["Value Dt"] ?? row["Value Date"] ?? row["VALUE DATE"] ?? row["Date"] ?? "").trim(),
      narration: narration || "",
      cheque_ref: chequeRef || "",
      withdrawal: withdrawalAmt !== null ? String(withdrawalAmt) : "",
      deposit: depositAmt !== null ? String(depositAmt) : "",
      balance: String(row["Closing Balance"] ?? row["Balance"] ?? "").trim(),
      merchant_name: merchantName || "",
      group_key: groupKey || ""
    });

        if (withdrawalAmt !== null && withdrawalAmt > 0) {
          const existingDebit = await db.query(
            `SELECT id, status FROM ${DB_SCHEMA}.contra_vouchers
             WHERE company_id = $1 AND bank_ledger = $2 AND voucher_date = $3
               AND amount = $4 AND debit_credit = 'DEBIT' AND narration IS NOT DISTINCT FROM $5`,
            [company_id, bank_ledger, txnDate, withdrawalAmt, narration]
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
             WHERE company_id = $1 AND bank_ledger = $2 AND voucher_date = $3
               AND amount = $4 AND debit_credit = 'CREDIT' AND narration IS NOT DISTINCT FROM $5`,
            [company_id, bank_ledger, txnDate, depositAmt, narration]
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

   Accepts MULTIPLE files in one request via the "files" field. Each
   file is parsed, enriched, and inserted independently by
   processStatementFile(); one file failing (bad password,
   unreadable, no valid rows) does not block the others. A same-named
   file is auto-renamed (see getUniqueFileName) rather than rejected,
   so it always ends up as its own separate section — files are never
   merged together. The response returns a `files[]` array — one
   section per uploaded file, keyed by file_name — so the frontend
   can render a separate review section for each file, mirroring the
   shape used by /statement-transactions.

   Still works fine with a single file — `files` will just contain
   one entry.
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

      // Process every file independently — one file's failure doesn't
      // block the others; each becomes its own section below. A
      // same-named file is auto-renamed inside processStatementFile
      // rather than rejected, so files are never merged.
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
        files: results   // <-- one section per uploaded file, by file_name
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

   CHANGED (per request): raw per-file data is now FULL — every row
   for every file, never filtered by group membership — and stays
   separated by file_name under `files[]`.

   The "AI suggestion" groups (merchant/group_key clusters) are now
   built ONCE, across ALL files combined — not per file. So if the
   same group_key shows up in two different uploaded files, it comes
   back as a SINGLE merged group (combined count/totals/transactions)
   in the top-level `groups[]` array, instead of two separate groups
   nested under two different files. Each transaction inside a group
   still carries its own `file_name` so you can trace which file it
   came from.
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

    let targetFileName = file_name;

    if (!targetFileName) {
      const latest = await db.query(
        `SELECT file_name
         FROM ${DB_SCHEMA}.contra_vouchers
         WHERE company_id = $1
           AND file_name IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [company_id]
      );

      if (!latest.rows.length) {
        return res.status(404).json({
          success: false,
          message: "No statement found for this company"
        });
      }

      targetFileName = latest.rows[0].file_name;
    }

    const result = await db.query(
      `SELECT
        voucher_date,
        narration,
        instrument_number,
        amount,
        debit_credit,
        merchant_name,
        group_key,
        file_name
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

    // ---- FULL per-file data (every row, every file — no group filtering,
    //      never merged/filtered by file_name across files) ----
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

    // ---- AI suggestion groups: merged ACROSS all files by group_key ----
    const groupsMap = new Map();
    for (const r of result.rows) {
      const key = r.group_key || "__ungrouped__";
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          group_key: r.group_key || null,
          merchant_name: r.merchant_name || null,
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
        r.voucher_date ? new Date(r.voucher_date).toISOString().split("T")[0] : "",
        r.file_name   // keeps identical txns in two different files from deduping into one
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
      files,          // full raw data, still separated by file_name
      group_count: groups.length,
      groups          // AI suggestion — merged across all files by group_key
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

   Matches by company_name only (contra_vouchers has both company_id
   and company_name — using company_name so both tables use the same
   key). company_id no longer required or used.

   PERFORMANCE: app_test.vouchers is ~14M rows. That side of the query
   only runs when narration is passed, and always filters by
   company_name + narration ILIKE together. Make sure you have:
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
     CREATE INDEX IF NOT EXISTS idx_vouchers_narration_trgm
       ON app_test.vouchers USING gin (narration gin_trgm_ops);
     CREATE INDEX IF NOT EXISTS idx_vouchers_company_name
       ON app_test.vouchers (company_name);
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

    // Only bring the 14M-row `vouchers` table into the plan when a
    // narration filter is actually supplied. With no narration, the
    // "no narration" branch is a compile-time no-op — Postgres never
    // even considers scanning `vouchers`.
    const vouchersBranch = narrationPattern
      ? `
        UNION ALL

        SELECT
          party_ledger_name AS party_ledger,
          narration,
          voucher_date
        FROM app_test.vouchers
        WHERE company_name = $1
          AND party_ledger_name IS NOT NULL
          AND narration ILIKE $2
      `
      : "";

    const result = await db.query(
      `
      WITH combined AS (
        SELECT party_ledger, narration, voucher_date
        FROM app_test.contra_vouchers
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

   Separate from /suggest-party-ledger on purpose — that route does
   pure SQL (exact/ILIKE narration matching) against contra_vouchers
   + vouchers (14M rows). This one spawns a Python process per call
   to embed the incoming group_key, so it's kept as its own endpoint
   rather than adding that latency to the existing route.

   Only returns a suggestion when similarity >= 0.8 (SIMILARITY_THRESHOLD
   in ledgerEmbedding.js). Below that, suggested: false — frontend
   should leave the ledger field for manual selection, same as today.
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

    const result = await suggestLedgerByGroupKey({ companyName: company_name, groupKey: group_key });

    return res.status(200).json({
      success: true,
      ...result
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
    const { company_id } = req.query;

    if (!company_id) {
      return res.status(400).json({ success: false, message: "company_id is required" });
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
       ORDER BY voucher_date ASC, id ASC`,
      [company_id]
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
=========================== */

async function assignPartyLedger(vouchers, forcePushFlag) {
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
           status        = 'PENDING'
         WHERE id = $4
           AND status IN ('WAITING_LEDGER', 'FAILED')
         RETURNING id`,
        [v.party_ledger, v.voucher_type.toLowerCase(),
         isContra ? v.party_ledger : null, v.id]
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
          `UPDATE app_test.contra_vouchers SET status = 'WAITING_LEDGER' WHERE id = $1`,
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

router.put("/party-ledger", async (req, res) => {
  try {
    const forcePushFlag = req.body.forcePush === true;

    const vouchers = Array.isArray(req.body.vouchers)
      ? req.body.vouchers
      : [{
          id: req.body.id,
          party_ledger: req.body.party_ledger,
          voucher_type: req.body.voucher_type
        }];

    if (!vouchers.length || !vouchers[0]?.id) {
      return res.status(400).json({
        success: false,
        message: "Provide either { id, party_ledger, voucher_type } or { vouchers: [...] }"
      });
    }

    const { status, body } = await assignPartyLedger(vouchers, forcePushFlag);
    return res.status(status).json(body);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   BACKWARD-COMPATIBLE ALIASES (temporary)
=========================== */

router.put("/bulk-party-ledger", async (req, res) => {
  try {
    const forcePushFlag = req.body.forcePush === true;
    const vouchers = Array.isArray(req.body.vouchers) ? req.body.vouchers : [];

    if (!vouchers.length) {
      return res.status(400).json({
        success: false,
        message: "vouchers[] array is required. Each item needs: id, party_ledger, voucher_type"
      });
    }

    const { status, body } = await assignPartyLedger(vouchers, forcePushFlag);
    return res.status(status).json(body);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
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
=========================== */

router.post("/:id/confirm-push", async (req, res) => {
  try {
    const voucherId = Number(req.params.id);

    const result = await db.query(
      `UPDATE ${DB_SCHEMA}.contra_vouchers
       SET
         party_ledger  = $1,
         voucher_type  = $2,
         transfer_bank = $3,
         status        = 'PENDING'
       WHERE id = $4
         AND status IN ('WAITING_LEDGER', 'FAILED')
       RETURNING *`,
      [voucherId]
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
      `UPDATE app_test.contra_vouchers
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