import express from "express";
import multer from "multer";
import fs from "fs";
import XLSX from "xlsx";
import ExcelJS from "exceljs";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";

import { DB_SCHEMA } from "../config/db.js";
import { bulkPurchaseQueue, BULK_PURCHASE_JOB_OPTIONS, getPurchaseReportJobId, getSpareStatementJobId } from "../queues/bulkPurchase.queue.js";
import { safeEnqueuePurchase } from "../queues/purchase.queue.js";
import { requireFeature } from "../utils/featureFlags.js";
import { computeBilledAmount } from "../workers/bulkPurchase.worker.js";

const FEATURE_KEY = "bulk_purchase_reconciliation";

const router = express.Router();

const UPLOAD_DIR = "uploads/bulk-purchase";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel"
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
  }
});

// Scoped to this acting user's own pairing, not a bare global name match —
// same fix/rationale as bulkSalesUpload.routes.js and invoices.routes.js.
async function resolveCompanyId(userId, companyName) {
  const result = await pool.query(
    `
    SELECT c.id
    FROM ${DB_SCHEMA}.companies c
    JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
    WHERE cpt.user_id = $1
      AND cpt.is_used = TRUE
      AND lower(trim(c.name)) = lower(trim($2))
    LIMIT 1
    `,
    [userId, companyName]
  );

  return result.rows[0]?.id || null;
}

/* =========================================
   ROUTINE: Purchase Report upload — every cycle, independent of whether a
   Spare Statement is available. See bulkPurchase.worker.js for what this
   resolves on its own vs what stays pending_dispatch.
========================================= */
router.post(
  "/bulk-purchase-upload/purchase-report",
  verifySession(),
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = await getLocalUserId(req.session.getUserId());
      if (!userId) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ status: "error", message: "No profile found for this account" });
      }

      const company = req.body.company?.trim();
      if (!company) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: "company is required" });
      }

      // "YYYY-MM" — the month the user picked in the upload modal, not
      // derived from the file's own PO dates (see the month_label
      // migration's rationale). Required: every purchase_po_lines row
      // this job touches needs to land in exactly one month bucket for
      // the Months table / drill-down / per-month report to work.
      const month = req.body.month?.trim();
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: "month is required, in YYYY-MM form" });
      }

      if (!req.file) {
        return res.status(400).json({ status: "error", message: "Excel file is required" });
      }

      const companyId = await resolveCompanyId(userId, company);
      if (!companyId) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: `Company not found: ${company}` });
      }

      if (!(await requireFeature(companyId, FEATURE_KEY, res))) {
        fs.unlink(req.file.path, () => {});
        return;
      }

      const batchId = Date.now();

      await bulkPurchaseQueue.add(
        "parse-purchase-report",
        { batchId, companyId, userId, month, filePath: req.file.path, originalFilename: req.file.originalname },
        { ...BULK_PURCHASE_JOB_OPTIONS, jobId: getPurchaseReportJobId(batchId) }
      );

      console.log("Bulk purchase report upload queued", { batchId, companyId, userId, month, filename: req.file.originalname });

      return res.status(200).json({
        status: "success",
        message: "Purchase report queued for reconciliation",
        batchId,
        month,
        filename: req.file.originalname
      });
    } catch (error) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      console.error("Bulk purchase report upload error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  }
);

/* =========================================
   OCCASIONAL: Spare Statement upload — month-scoped so the monthly
   reconciliation report can group entries correctly. Still re-checks the
   ODN backlog for the whole company (an ODN can legitimately resolve a
   pending line from an earlier month), only the statement's own rows are
   tagged with the month the user picked.
========================================= */
router.post(
  "/bulk-purchase-upload/spare-statement",
  verifySession(),
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = await getLocalUserId(req.session.getUserId());
      if (!userId) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ status: "error", message: "No profile found for this account" });
      }

      const company = req.body.company?.trim();
      if (!company) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: "company is required" });
      }

      const month = req.body.month?.trim();
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: "month is required, in YYYY-MM form" });
      }

      if (!req.file) {
        return res.status(400).json({ status: "error", message: "Excel file is required" });
      }

      const companyId = await resolveCompanyId(userId, company);
      if (!companyId) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ status: "error", message: `Company not found: ${company}` });
      }

      if (!(await requireFeature(companyId, FEATURE_KEY, res))) {
        fs.unlink(req.file.path, () => {});
        return;
      }

      const batchId = Date.now();

      await bulkPurchaseQueue.add(
        "reconcile-spare-statement",
        { batchId, companyId, userId, filePath: req.file.path, originalFilename: req.file.originalname, month },
        { ...BULK_PURCHASE_JOB_OPTIONS, jobId: getSpareStatementJobId(batchId) }
      );

      console.log("Bulk spare statement upload queued", { batchId, companyId, userId, filename: req.file.originalname });

      return res.status(200).json({
        status: "success",
        message: "Spare statement queued to re-check the pending backlog",
        batchId,
        filename: req.file.originalname
      });
    } catch (error) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      console.error("Bulk spare statement upload error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  }
);

/* =========================================
   Batch status — counts from purchase_po_lines for one upload's batchId.
========================================= */
router.get("/bulk-purchase-upload/:batchId/status", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const { batchId } = req.params;

    const result = await pool.query(
      `
      SELECT match_status, COUNT(*)::int AS count
      FROM ${DB_SCHEMA}.purchase_po_lines
      WHERE company_id = $1 AND source_batch_id = $2
      GROUP BY match_status
      `,
      [companyId, batchId]
    );

    const counts = { pending_dispatch: 0, matched: 0, pushed: 0 };
    result.rows.forEach((r) => { counts[r.match_status] = r.count; });

    return res.status(200).json({ status: "success", batchId, counts });
  } catch (error) {
    console.error("Bulk purchase status error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   Months list — one row per (company, month_label), with the same
   matched/pending/review breakdown the Months table shows. Drives the
   page's landing view; drilling into one month re-scopes the existing
   All Invoices / Review Invoices / Pending Dispatch tabs by month_label.
========================================= */
router.get("/bulk-purchase-upload/months", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    // Every distinct invoice_no this month's lines resolved to, split by
    // whether pushInvoice.worker.js ultimately succeeded or is stuck
    // needing review — joined back from invoice_extractions since
    // purchase_po_lines.match_status only tracks "handed off", not the
    // actual push outcome.
    const result = await pool.query(
      `
      SELECT
        p.month_label,
        COUNT(DISTINCT p.invoice_no)::int AS total_vouchers,
        COUNT(*) FILTER (WHERE p.match_status = 'pending_dispatch')::int AS pending_count,
        COUNT(DISTINCT ie.id) FILTER (WHERE ie.sync_status = 'success')::int AS matched_count,
        COUNT(DISTINCT ie.id) FILTER (WHERE ie.sync_status IN ('ledger_missing','stock_missing','ledger_and_stock_missing','failed'))::int AS review_count,
        MIN(p.created_at) AS first_uploaded_at,
        MAX(p.updated_at) AS last_updated_at
      FROM ${DB_SCHEMA}.purchase_po_lines p
      LEFT JOIN ${DB_SCHEMA}.invoice_extractions ie ON ie.id = p.invoice_extraction_id
      WHERE p.company_id = $1 AND p.month_label IS NOT NULL
      GROUP BY p.month_label
      ORDER BY p.month_label DESC
      `,
      [companyId]
    );

    return res.status(200).json({ status: "success", data: result.rows });
  } catch (error) {
    console.error("Bulk purchase months list error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   Per-month reconciled Excel report — every PO line from that month,
   whatever its outcome (pushed, pending dispatch, or needing review),
   in one downloadable .xlsx. Distinct from the CSV pending-only report
   below: this is the full month, not just the unresolved slice.
========================================= */
router.get("/bulk-purchase-upload/months/:month/report", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const { month } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.po_no, p.po_line_item, p.po_date, p.vendor_name, p.material_code, p.material_description,
        p.hsn_code, p.quantity, p.unit, p.amount, p.taxable_amount, p.tax_amount, p.tax_description,
        p.invoice_no, p.invoice_date, p.match_status,
        ie.sync_status AS push_status, ie.error_message
      FROM ${DB_SCHEMA}.purchase_po_lines p
      LEFT JOIN ${DB_SCHEMA}.invoice_extractions ie ON ie.id = p.invoice_extraction_id
      WHERE p.company_id = $1 AND p.month_label = $2
      ORDER BY p.po_no, p.po_line_item
      `,
      [companyId, month]
    );

    const rows = result.rows.map((r) => ({
      "PO No.": r.po_no,
      "PO Line": r.po_line_item,
      "PO Date": r.po_date,
      "Vendor": r.vendor_name,
      "Material Code": r.material_code,
      "Description": r.material_description,
      "HSN Code": r.hsn_code,
      "Quantity": r.quantity,
      "Unit": r.unit,
      "Amount": r.amount,
      "Taxable Amount": r.taxable_amount,
      "Tax Amount": r.tax_amount,
      "Tax Type": r.tax_description,
      "Invoice No.": r.invoice_no || "",
      "Invoice Date": r.invoice_date || "",
      "Status": r.match_status === "pending_dispatch"
        ? "Pending Dispatch"
        : r.push_status === "success" ? "Pushed to Tally"
        : r.push_status ? "Needs Review"
        : r.match_status,
      "Issue": r.error_message ? (() => { try { return JSON.parse(r.error_message).message; } catch { return r.error_message; } })() : ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, month);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="purchase-reconciliation-${month}.xlsx"`);
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("Bulk purchase month report error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   Month-end pending-dispatch report — a plain read, no job involved.
   This is the actual deliverable for lines that never resolve (see
   plan.md's 5-month validation): sorted oldest PO date first, with the
   age-since-PO-date the report is built around. Optional ?month= scopes
   it to one month's drill-down instead of the whole company backlog.
========================================= */
router.get("/bulk-purchase-upload/pending-report", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const month = req.query.month?.trim();

    const result = await pool.query(
      `
      SELECT
        po_no, po_line_item, po_date,
        (CURRENT_DATE - po_date) AS days_pending,
        vendor_name, vendor_code, material_code, material_description, hsn_code,
        quantity, unit, amount, taxable_amount, tax_amount, tax_description,
        godown_name, odn, inbound_delivery_no, amount_match_note
      FROM ${DB_SCHEMA}.purchase_po_lines
      WHERE company_id = $1 AND match_status = 'pending_dispatch'
        AND ($2::text IS NULL OR month_label = $2)
      ORDER BY po_date ASC NULLS LAST
      `,
      [companyId, month || null]
    );

    if (req.query.format === "csv") {
      const header = "PO No.,PO Line,PO Date,Days Pending,Vendor,Material,Description,Amount,Possible Match";
      const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = result.rows.map((r) => [
        r.po_no, r.po_line_item, r.po_date, r.days_pending,
        r.vendor_name, r.material_code, r.material_description, r.amount, r.amount_match_note
      ].map(csvEscape).join(","));

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="pending-dispatch-report.csv"`);
      return res.status(200).send([header, ...lines].join("\n"));
    }

    return res.status(200).json({
      status: "success",
      count: result.rows.length,
      totalAmount: result.rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      data: result.rows
    });
  } catch (error) {
    console.error("Bulk purchase pending-report error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   POST /bulk-purchase-upload/pending/resolve
   Manually resolve one pending PO group (everything known except the
   invoice number) into a real invoice and push it — the same outcome an
   automated ODN/amount match reaches, just triggered by a person typing
   in the invoice number on the Pending Dispatch "View" screen instead of
   waiting for a Spare Statement to supply it.
========================================= */
router.post("/bulk-purchase-upload/pending/resolve", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.body.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const poNo = req.body.po_no?.trim();
    if (!poNo) return res.status(400).json({ status: "error", message: "po_no is required" });

    const invoiceData = req.body.invoice_data;
    if (!invoiceData) return res.status(400).json({ status: "error", message: "invoice_data is required" });

    const { vendor_name, gstin, invoice_no, invoice_date } = invoiceData;
    if (!vendor_name?.trim()) return res.status(400).json({ status: "error", message: "vendor_name is required" });
    if (!invoice_no?.trim()) return res.status(400).json({ status: "error", message: "invoice_no is required" });

    const pendingCheck = await pool.query(
      `SELECT id FROM ${DB_SCHEMA}.purchase_po_lines WHERE company_id = $1 AND po_no = $2 AND match_status = 'pending_dispatch' LIMIT 1`,
      [companyId, poNo]
    );
    if (!pendingCheck.rows.length) {
      return res.status(404).json({ status: "error", message: `No pending_dispatch lines found for PO ${poNo} — it may have already been resolved.` });
    }

    const insertResult = await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.invoice_extractions
        (company_id, company_name, vendor_name, gstin, invoice_no, invoice_date, raw_json, sync_status, user_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW(),NOW())
      ON CONFLICT (company_id, invoice_no) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        vendor_name = EXCLUDED.vendor_name,
        gstin = EXCLUDED.gstin,
        invoice_date = EXCLUDED.invoice_date,
        raw_json = EXCLUDED.raw_json,
        sync_status = 'pending',
        error_message = NULL,
        user_id = EXCLUDED.user_id,
        updated_at = NOW()
      RETURNING id
      `,
      [companyId, company, vendor_name.trim(), gstin?.trim() || "", invoice_no.trim(), invoice_date || null, JSON.stringify(invoiceData), userId]
    );
    const invoiceId = insertResult.rows[0].id;

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.purchase_po_lines
      SET invoice_no = $1, invoice_date = $2, match_status = 'matched', invoice_extraction_id = $3, amount_match_note = NULL, updated_at = NOW()
      WHERE company_id = $4 AND po_no = $5 AND match_status = 'pending_dispatch'
      `,
      [invoice_no.trim(), invoice_date || null, invoiceId, companyId, poNo]
    );

    await safeEnqueuePurchase(invoiceId, userId);

    return res.status(200).json({ status: "success", invoiceId });
  } catch (error) {
    console.error("Bulk purchase pending-resolve error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   MONTHLY ODN RECONCILIATION — the two directions the client asked to
   see, both keyed on ODN (never PO number, since one PO can span several
   ODNs/invoices):
     - "in statement, not in report": a Spare Statement row whose
       Ref. Doc No. matches no purchase_po_lines.odn/inbound_delivery_no
       for this company at all (any month — an ODN can legitimately land
       in an earlier/later month's Purchase Report than the statement
       that references it).
     - "in report, not in statement": a Purchase Report line that HAS an
       ODN but is still match_status='pending_dispatch' for this
       company+month — after the ingestion-time filter (see
       bulkPurchase.worker.js's processPurchaseReportJob), a pending_
       dispatch row only ever exists when it has an ODN, so no extra
       filter is needed here. Expected to be empty for a client whose SAP
       export always sets ODN and Vendor Invoice No. together, but kept
       for whenever that pattern changes.
========================================= */
async function loadReconciliation(companyId, month) {
  const inStatementNotInReport = await pool.query(
    `
    SELECT s.ref_doc_no, s.invoice_no, s.posting_date, s.doc_type, s.debit_amount
    FROM ${DB_SCHEMA}.spare_statement_entries s
    WHERE s.company_id = $1
      AND ($2::text IS NULL OR s.month_label = $2)
      AND s.doc_type IS DISTINCT FROM 'DZ'
      -- Credit-side RV entries (debit_amount NULL) are receipts, not
      -- purchase-related — not something this reconciliation should flag.
      AND NOT (s.doc_type = 'RV' AND s.debit_amount IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM ${DB_SCHEMA}.purchase_po_lines p
        WHERE p.company_id = $1 AND (p.odn = s.ref_doc_no OR p.inbound_delivery_no = s.ref_doc_no)
      )
    ORDER BY s.posting_date ASC NULLS LAST
    `,
    [companyId, month || null]
  );

  const inReportNotInStatement = await pool.query(
    `
    SELECT po_no, po_line_item, po_date, vendor_name, odn, inbound_delivery_no, amount
    FROM ${DB_SCHEMA}.purchase_po_lines
    WHERE company_id = $1 AND match_status = 'pending_dispatch'
      AND ($2::text IS NULL OR month_label = $2)
    ORDER BY po_date ASC NULLS LAST
    `,
    [companyId, month || null]
  );

  return { inStatementNotInReport: inStatementNotInReport.rows, inReportNotInStatement: inReportNotInStatement.rows };
}

// Shared by loadReconciliationTable's Amount Match column and
// loadAmountMismatches below.
const AMOUNT_MISMATCH_TOLERANCE = 1; // rupee, after rounding — real data matched exactly once grouped by ODN

// One row per ODN for the month — shared by GET .../reconciliation-table
// (on-screen tab) and GET .../reconciliation-report (its third sheet), so
// the download always matches exactly what's on screen.
async function loadReconciliationTable(companyId, month) {
  const result = await pool.query(
    `
    SELECT
      p.odn,
      (ARRAY_AGG(p.vendor_name ORDER BY p.id))[1] AS vendor_name,
      (ARRAY_AGG(p.invoice_date ORDER BY p.id))[1] AS voucher_date,
      BOOL_OR(p.match_status = 'pushed') AS present_in_tally,
      EXISTS (
        SELECT 1 FROM ${DB_SCHEMA}.spare_statement_entries s
        WHERE s.company_id = p.company_id AND s.ref_doc_no = p.odn
      ) AS present_in_ledger
    FROM ${DB_SCHEMA}.purchase_po_lines p
    WHERE p.company_id = $1 AND p.month_label = $2 AND p.odn IS NOT NULL AND p.odn <> ''
    GROUP BY p.odn, p.company_id
    ORDER BY p.odn
    `,
    [companyId, month]
  );
  const rows = result.rows;
  if (rows.length === 0) return rows;

  // Amount Match — reuses the same per-ODN billed-amount logic as
  // loadAmountMismatches() (grouped by ODN alone, since one delivery can
  // bundle line items from several PO numbers — see that function's
  // comment) so the tab's column and the downloaded report always agree.
  const odns = rows.map((r) => r.odn);
  const linesResult = await pool.query(
    `
    SELECT odn, amount, taxable_amount, tax_amount, gr_amount
    FROM ${DB_SCHEMA}.purchase_po_lines
    WHERE company_id = $1 AND month_label = $2 AND odn = ANY($3) AND match_status IN ('matched', 'pushed')
    `,
    [companyId, month, odns]
  );
  const billedTotalByOdn = new Map();
  for (const line of linesResult.rows) {
    const { billedAmount } = computeBilledAmount(line);
    billedTotalByOdn.set(line.odn, (billedTotalByOdn.get(line.odn) || 0) + billedAmount);
  }

  const stmtResult = await pool.query(
    `
    SELECT ref_doc_no, debit_amount
    FROM ${DB_SCHEMA}.spare_statement_entries
    WHERE company_id = $1 AND ref_doc_no = ANY($2)
      AND doc_type IS DISTINCT FROM 'DZ'
      AND NOT (doc_type = 'RV' AND debit_amount IS NULL)
    `,
    [companyId, odns]
  );
  const statementAmountByOdn = new Map(stmtResult.rows.map((r) => [r.ref_doc_no, Number(r.debit_amount)]));

  for (const row of rows) {
    const billedTotal = billedTotalByOdn.get(row.odn);
    const statementAmount = statementAmountByOdn.get(row.odn);
    // Can't meaningfully compare unless both a report-side amount and a
    // legitimate (non-DZ, non-credit-RV) statement debit exist for it.
    if (billedTotal === undefined || statementAmount === undefined) {
      row.amount_match = "N/A";
    } else {
      row.amount_match = Math.abs(Math.round(billedTotal) - statementAmount) <= AMOUNT_MISMATCH_TOLERANCE ? "Yes" : "No";
    }
  }
  return rows;
}

/* =========================================
   AMOUNT MISMATCH — does the Purchase Report agree with the Purchase
   (Spare Account) Statement on how much a delivery was actually worth?
   The Statement's Ref. Doc No. is delivery-level (one row per ODN), but
   SAP sometimes bundles more than one PO number's line items into a
   single delivery — confirmed on real data: the same Inbound Delivery
   No. and Vendor Invoice No. appearing under several distinct PO
   numbers, all settled by one Statement debit. So grouping must be by
   ODN alone, summing across every PO number that shares it — not by PO
   number (an ODN's items can't be reliably attributed back to "its" PO
   for this check, since the Statement never sees the PO number at all).
========================================= */
async function loadAmountMismatches(companyId, month) {
  const linesResult = await pool.query(
    `
    SELECT po_no, odn, vendor_name, invoice_no, amount, taxable_amount, tax_amount, gr_amount
    FROM ${DB_SCHEMA}.purchase_po_lines
    WHERE company_id = $1
      AND ($2::text IS NULL OR month_label = $2)
      AND match_status IN ('matched', 'pushed')
      AND odn IS NOT NULL AND odn <> ''
    `,
    [companyId, month || null]
  );

  const byOdn = new Map();
  for (const row of linesResult.rows) {
    const { billedAmount } = computeBilledAmount(row);
    let entry = byOdn.get(row.odn);
    if (!entry) {
      entry = { odn: row.odn, vendorName: row.vendor_name, poNos: new Set(), invoiceNos: new Set(), billedTotal: 0 };
      byOdn.set(row.odn, entry);
    }
    entry.billedTotal += billedAmount;
    entry.poNos.add(row.po_no);
    entry.invoiceNos.add(row.invoice_no);
  }

  if (byOdn.size === 0) return [];

  const odns = [...byOdn.keys()];
  const stmtResult = await pool.query(
    `
    SELECT ref_doc_no, invoice_no, debit_amount
    FROM ${DB_SCHEMA}.spare_statement_entries
    WHERE company_id = $1
      AND ref_doc_no = ANY($2)
      AND doc_type IS DISTINCT FROM 'DZ'
      -- Credit-side RV entries are receipts, not purchases — same
      -- exclusion already applied in loadReconciliation().
      AND NOT (doc_type = 'RV' AND debit_amount IS NULL)
    `,
    [companyId, odns]
  );
  const statementByOdn = new Map(stmtResult.rows.map((r) => [r.ref_doc_no, r]));

  const mismatches = [];
  for (const entry of byOdn.values()) {
    const statementRow = statementByOdn.get(entry.odn);
    // No Statement entry at all for this ODN is already covered by the
    // "In Report, not in Statement" bucket — not an amount mismatch.
    if (!statementRow) continue;

    const reportAmount = Math.round(entry.billedTotal);
    const statementAmount = Number(statementRow.debit_amount);
    const difference = reportAmount - statementAmount;
    if (Math.abs(difference) <= AMOUNT_MISMATCH_TOLERANCE) continue;

    mismatches.push({
      odn: entry.odn,
      po_nos: [...entry.poNos],
      vendor_name: entry.vendorName,
      // "Aggregated" = this delivery's Statement debit covers line items
      // pulled from more than one PO number, so the report-side total
      // being compared is a sum across POs, not a single PO's own amount.
      match_type: entry.poNos.size > 1 ? "Aggregated" : "Direct",
      report_invoice_nos: [...entry.invoiceNos],
      statement_invoice_no: statementRow.invoice_no,
      report_amount: reportAmount,
      statement_amount: statementAmount,
      difference
    });
  }

  mismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return mismatches;
}

router.get("/bulk-purchase-upload/reconciliation-summary", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const month = req.query.month?.trim();
    const { inStatementNotInReport, inReportNotInStatement } = await loadReconciliation(companyId, month);
    const amountMismatches = await loadAmountMismatches(companyId, month);

    return res.status(200).json({
      status: "success",
      inStatementNotInReport: inStatementNotInReport.length,
      inReportNotInStatement: inReportNotInStatement.length,
      mismatchCount: amountMismatches.length
    });
  } catch (error) {
    console.error("Bulk purchase reconciliation-summary error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

/* =========================================
   RECONCILIATION TABLE — one row per ODN for the selected month, showing
   whether it actually landed in Tally (match_status='pushed' on its
   purchase_po_lines row) versus whether it's independently confirmed in
   the accounts ledger (a Spare Statement entry whose Ref. Doc No. matches
   this ODN). Distinct from reconciliation-summary/-report above, which
   only count/export the "missing entirely from one side" cases — this
   lists every ODN either way, for a full per-line audit view.
========================================= */
router.get("/bulk-purchase-upload/reconciliation-table", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const month = req.query.month?.trim();
    if (!month) return res.status(400).json({ status: "error", message: "month query param is required" });

    const rows = await loadReconciliationTable(companyId, month);

    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    console.error("Bulk purchase reconciliation-table error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

router.get("/bulk-purchase-upload/reconciliation-report", verifySession(), async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());
    if (!userId) return res.status(404).json({ status: "error", message: "No profile found for this account" });

    const company = req.query.company?.trim();
    if (!company) return res.status(400).json({ status: "error", message: "company query param is required" });

    const companyId = await resolveCompanyId(userId, company);
    if (!companyId) return res.status(400).json({ status: "error", message: `Company not found: ${company}` });

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const month = req.query.month?.trim();
    const { inStatementNotInReport } = await loadReconciliation(companyId, month);
    const reconciliationTableRows = month ? await loadReconciliationTable(companyId, month) : [];
    const amountMismatches = await loadAmountMismatches(companyId, month);

    const statementSheetRows = inStatementNotInReport.map((r) => ({
      "Ref. Doc No.": r.ref_doc_no,
      "Invoice No.": r.invoice_no,
      "Posting Date": r.posting_date,
      "Doc Type": r.doc_type,
      "Debit Amount": r.debit_amount
    }));

    // A voucher is "Reconciled" only once it's confirmed on both sides —
    // pushed into Tally AND matched against a Spare Statement entry.
    // Anything missing from either side (or both) is "Not Reconciled",
    // same rows the on-screen Reconciliation tab shows in red.
    const reconciledRows = reconciliationTableRows.filter((r) => r.present_in_tally && r.present_in_ledger);
    const notReconciledRows = reconciliationTableRows.filter((r) => !r.present_in_tally || !r.present_in_ledger);

    const toSheetRows = (rows) => rows.map((r, i) => ({
      "Sr. No.": i + 1,
      "Voucher Date": r.voucher_date,
      "ODN Number": r.odn,
      "Vendor Name": r.vendor_name,
      "Present in Tally": r.present_in_tally ? "Yes" : "No",
      "Present in Ledger": r.present_in_ledger ? "Yes" : "No",
      "Amount Match": r.amount_match
    }));

    // exceljs (not xlsx — the free/community xlsx package can't write
    // cell styles) so the Amount Mismatch sheet's rows can actually be
    // highlighted, not just flagged in a text column.
    const workbook = new ExcelJS.Workbook();

    const addPlainSheet = (name, rows) => {
      const sheet = workbook.addWorksheet(name);
      if (rows.length === 0) return sheet;
      sheet.columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => sheet.addRow(r));
      return sheet;
    };

    addPlainSheet("Reconciled Vouchers", toSheetRows(reconciledRows));
    addPlainSheet("Not Reconciled", toSheetRows(notReconciledRows));
    addPlainSheet("In Statement, not in Report", statementSheetRows);

    const mismatchSheet = workbook.addWorksheet("Amount Mismatch");
    mismatchSheet.columns = [
      { header: "ODN Number", key: "odn" },
      { header: "PO Number(s)", key: "poNos" },
      { header: "Vendor Name", key: "vendorName" },
      { header: "Match Type", key: "matchType" },
      { header: "Invoice No. (Report)", key: "reportInvoiceNos" },
      { header: "Invoice No. (Statement)", key: "statementInvoiceNo" },
      { header: "Report Amount", key: "reportAmount" },
      { header: "Statement Amount", key: "statementAmount" },
      { header: "Difference", key: "difference" }
    ];
    mismatchSheet.getRow(1).font = { bold: true };
    const mismatchFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
    for (const m of amountMismatches) {
      const row = mismatchSheet.addRow({
        odn: m.odn,
        poNos: m.po_nos.join(", "),
        vendorName: m.vendor_name,
        matchType: m.match_type,
        reportInvoiceNos: m.report_invoice_nos.join(", "),
        statementInvoiceNo: m.statement_invoice_no,
        reportAmount: m.report_amount,
        statementAmount: m.statement_amount,
        difference: m.difference
      });
      row.eachCell((cell) => { cell.fill = mismatchFill; });
    }

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="odn-reconciliation${month ? `-${month}` : ""}.xlsx"`);
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("Bulk purchase reconciliation-report error:", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});

export default router;
