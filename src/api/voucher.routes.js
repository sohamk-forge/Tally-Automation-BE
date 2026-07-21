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
   UPLOAD BANK STATEMENT (EXCEL)
   Now includes semantic enrichment (merchant_name, group_key)
   that used to live on the separate :8000 FastAPI service.
   Returns BOTH:
     - data         → DB-backed voucher rows (for "Review")
     - transactions → enriched raw transaction list (for "AI Suggestion")
=========================== */

router.post(
  "/upload-statement",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
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

      if (!req.file) {
        return res.status(400).json({ success: false, message: "Excel file is required" });
      }
      if (!company_id || !company_name || !bank_ledger) {
        return res.status(400).json({
          success: false,
          message: "company_id, company_name and bank_ledger are required"
        });
      }

      const fileName = req.file.originalname;

      // Check if this exact file has already been uploaded for this company
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
        return res.status(409).json({
          success: false,
          already_exists: true,
          message: `This file "${fileName}" has already been uploaded.`,
          data: existingFile.rows[0]
        });
      }

      let workbook;
      try {
        workbook = xlsx.read(req.file.buffer, {
          type: "buffer",
          cellDates: true,
          password: password || undefined
        });
      } catch (xlsxErr) {
        return res.status(400).json({
          success: false,
          message: "Failed to read Excel file. If it is password protected, provide the correct password."
        });
      }

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const headerRowIndex = findHeaderRowIndex(sheet);

      let rawRows = xlsx.utils.sheet_to_json(sheet, {
        defval: null,
        raw: false,
        range: headerRowIndex
      });

      // Drop bank separator rows (e.g. rows full of ***)
      rawRows = rawRows.filter((row) => !isSeparatorRow(row));

      if (!rawRows.length) {
        return res.status(400).json({ success: false, message: "No data rows found in Excel" });
      }

      // ── Build narration list and run semantic enrichment ONCE for the whole file ──
      const narrationInputs = rawRows.map((row) => ({
        narration: String(
          row["Narration"] ?? row["Description"] ?? row["Particulars"] ?? ""
        ).trim()
      }));

      const enriched = await runSemanticEnrichment(narrationInputs);

      const inserted = [];      // → "Review" shape (DB-backed voucher rows)
      const transactions = [];  // → "AI Suggestion" shape (old FastAPI response shape)

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
        const groupKey = enriched[i]?.group_key || null;

        const rawRef = row["Chq./Ref.No."] ?? row["Chq/Ref No."] ?? row["Chq No"] ?? row["Ref No"] ?? "";
        const chequeRef = cleanString(rawRef) || null;

        // Build the AI-suggestion-style transaction entry (mirrors old FastAPI shape)
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

        // Withdrawal → DEBIT row
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

        // Deposit → CREDIT row
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
        return res.status(400).json({
          success: false,
          message: "No valid transaction rows found in the file"
        });
      }

      const newRows     = inserted.filter(v => v._action === 'inserted');
      const skippedRows = inserted.filter(v => v._action === 'skipped');
      const resetRows   = inserted.filter(v => v._action === 'reset');

      const allDates = inserted.map(v => v.voucher_date).filter(Boolean).sort();
      const startDate = allDates[0] || null;
      const endDate   = allDates[allDates.length - 1] || null;

      return res.status(201).json({
        success: true,
        message: `${newRows.length} new, ${skippedRows.length} skipped, ${resetRows.length} reset.`,

        // ── "Review" shape — DB-backed voucher rows ──
        file_name:      fileName,
        bank_ledger:    bank_ledger,
        start_date:     startDate,
        end_date:       endDate,
        total:          inserted.length,
        inserted_count: newRows.length,
        skipped_count:  skippedRows.length,
        reset_count:    resetRows.length,
        debit_count:    inserted.filter(v => v.debit_credit === "DEBIT").length,
        credit_count:   inserted.filter(v => v.debit_credit === "CREDIT").length,
        data: inserted,

        // ── "AI Suggestion" shape — mirrors old :8000 FastAPI response ──
        transactions: transactions
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
   Reshapes existing contra_vouchers rows (no schema change,
   no extra writes on upload) into the old FastAPI-style
   transaction list: { success, file_name, total, transactions }

   UPDATED: rows are now ordered by group_key first (so narrations
   belonging to the same merchant/group sit next to each other in
   the flat "transactions" list), and a new "groups" array buckets
   the same rows by group_key for easy client-side rendering.

   Query params:
     company_id  (required)
     file_name   (optional — if omitted, uses the most recently
                  uploaded file for that company)
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
         AND file_name = $2
       ORDER BY
         COALESCE(group_key, 'zzz_ungrouped') ASC,
         voucher_date ASC,
         id ASC`,
      [company_id, targetFileName]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: `No transactions found for file "${targetFileName}"`
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
      group_key: r.group_key || ""
    });

    // Build groups first
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
          transactions: []
        });
      }
      const bucket = groupsMap.get(key);
      const txn = toTxn(r);
      bucket.transactions.push(txn);
      bucket.count += 1;
      if (r.debit_credit === "DEBIT") bucket.total_withdrawal += Number(r.amount) || 0;
      if (r.debit_credit === "CREDIT") bucket.total_deposit += Number(r.amount) || 0;
    }

    // ── ONLY keep groups where the narration repeats (count > 1). ──
    // This drops: (a) the "__ungrouped__" bucket (narrations that never matched anything),
    // and (b) any real group_key bucket that only ever had a single row.
    const groups = [...groupsMap.values()]
      .filter(g => g.group_key !== null && g.count > 1)
      .sort((a, b) => b.count - a.count);

    // Flat list rebuilt from the filtered groups only (so it stays consistent with `groups`)
    const transactions = groups.flatMap(g => g.transactions);

    if (!transactions.length) {
      return res.status(404).json({
        success: false,
        message: `No repeated narrations found for file "${targetFileName}"`
      });
    }

    return res.status(200).json({
      success: true,
      file_name: targetFileName,
      total: transactions.length,
      group_count: groups.length,
      transactions,
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
   BULK ASSIGN party_ledger + voucher_type → triggers BullMQ

   FIX: previously called voucherQueue.add() directly with a
   deterministic jobId. If a job with that ID already existed in
   Redis (e.g. a previously FAILED job that hadn't been removed),
   BullMQ silently ignored the new add() call — so Postgres said
   PENDING but no job was ever actually queued. Now uses
   safeEnqueueVoucher(), which removes any stale job first.
=========================== */

router.put("/bulk-party-ledger", async (req, res) => {
  try {
    const { vouchers } = req.body;

    if (!Array.isArray(vouchers) || vouchers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "vouchers[] array is required. Each item needs: id, party_ledger, voucher_type"
      });
    }

    const allowed = ["payment", "receipt", "contra"];

    for (const v of vouchers) {
      if (!v.id || !v.party_ledger || !v.voucher_type) {
        return res.status(400).json({
          success: false,
          message: `Missing fields on: ${JSON.stringify(v)}. Need id, party_ledger, voucher_type`
        });
      }
      if (!allowed.includes(v.voucher_type.toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: `Invalid voucher_type "${v.voucher_type}" for id ${v.id}. Allowed: payment, receipt, contra`
        });
      }
    }

    const updatedIds = [];

    for (const v of vouchers) {
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

      if (result.rows.length > 0) updatedIds.push(result.rows[0].id);
    }

    if (updatedIds.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No matching WAITING_LEDGER or FAILED vouchers found"
      });
    }

    for (const voucherId of updatedIds) {
      await safeEnqueueVoucher(voucherId);
    }

    return res.status(200).json({
      success: true,
      message: `${updatedIds.length} vouchers assigned and queued for Tally`,
      queued: updatedIds
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ===========================
   SINGLE ASSIGN party_ledger + voucher_type

   FIX: same stale-jobId issue as bulk-party-ledger above — now
   uses safeEnqueueVoucher() instead of voucherQueue.add() directly.
=========================== */

router.put("/:id/party-ledger", async (req, res) => {
  try {
    const { party_ledger, voucher_type } = req.body;
    const voucherId = Number(req.params.id);

    if (!party_ledger || !voucher_type) {
      return res.status(400).json({
        success: false,
        message: "party_ledger and voucher_type are required"
      });
    }

    const allowed = ["payment", "receipt", "contra"];
    if (!allowed.includes(voucher_type.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Invalid voucher_type. Allowed: payment, receipt, contra"
      });
    }

    const isContra = voucher_type.toLowerCase() === "contra";

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
      [party_ledger, voucher_type.toLowerCase(),
       isContra ? party_ledger : null, voucherId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Voucher not found or already processed"
      });
    }

    await safeEnqueueVoucher(voucherId);

    return res.status(200).json({
      success: true,
      message: "Assigned and queued for Tally",
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