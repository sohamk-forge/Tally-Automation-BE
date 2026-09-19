import express from "express";
import pool from "../db/index.js";
import { safeEnqueuePurchase } from "../queues/purchase.queue.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { validateCompanyId } from "../utils/companyAccess.js";
import { findTopItemMatches } from "../utils/fuzzyItemMatch.js";
import { DB_SCHEMA } from "../config/db.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";

const router = express.Router();

// Fail fast when the user's own connector isn't live for this company.
// Previously the route saved + queued the invoice and answered "success";
// the offline connector was only discovered later in the worker, so the UI
// had already reported a successful push. Returns true if it has already
// sent the 409 response (caller must return).
async function rejectIfConnectorOffline(res, companyId, userId) {
  const connector = await resolveConnectorForCompany(companyId, userId);
  if (connector) return false;

  res.status(409).json({
    status: "error",
    code: "CONNECTOR_OFFLINE",
    message:
      "Tally connector is not running. Please open the connector (and Tally) and retry pushing this invoice to Tally."
  });
  return true;
}

// Shared by the three routes below — same user-scoped company-by-name
// lookup used throughout this codebase (bulkSalesUpload.routes.js,
// salesInvoices.routes.js's retry-batch/resolve-missing-item, etc).
async function resolveCompanyIdByName(userId, companyName) {
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

router.post("/invoices", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "Unauthenticated"
      });
    }

    const { company, invoice_data } = req.body;

    if (!company?.trim()) {
      return res.status(400).json({
        error: "Company is required"
      });
    }

    if (!invoice_data) {
      return res.status(400).json({
        error: "invoice_data is required"
      });
    }

    const { invoice_no, invoice_date, gstin } = invoice_data;

    if (!invoice_data.purchase_ledger?.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Please select a ledger before pushing to Tally."
      });
    }
    // The review form sends `vendor_name`; older callers send `customer_name`.
    // Reading only customer_name left the vendor column blank.
    const customer_name = invoice_data.customer_name || invoice_data.vendor_name;

    if (!invoice_no?.trim()) {
      return res.status(400).json({
        error: "invoice_no is required"
      });
    }

    console.log(`🔍 Looking up company: ${company.trim()}`);

    // Scoped to this acting user's own pairing, not a bare global name
    // match — two unrelated companies can share a name, and a global
    // lookup here would silently resolve to whichever row Postgres
    // happens to return, possibly someone else's company. This also
    // doubles as the ownership check (a company this user has no access
    // to simply won't match), replacing the old checkCompanyAccess call
    // that checked the vestigial user_companies table.
    const companyResult = await pool.query(
      `
      SELECT c.id
      FROM ${DB_SCHEMA}.companies c
      JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [userId, company.trim()]
    );

    if (!companyResult.rows.length) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    if (await rejectIfConnectorOffline(res, companyId, userId)) return;

    console.log(`📝 Creating/updating purchase invoice: ${invoice_no}`);

    // Upsert on (company_id, invoice_no) — the same combination the unique
    // constraint enforces. A retry, a corrected resubmission, or a simple
    // double-click on the same invoice_no must update and re-queue the
    // existing row, not crash with a raw duplicate-key error (see
    // bulkSales.worker.js for the identical pattern on the sales side).
    const insertResult = await pool.query(
      `INSERT INTO ${DB_SCHEMA}.invoice_extractions
       (
         company_id,
         company_name,
         vendor_name,
         gstin,
         invoice_no,
         invoice_date,
         raw_json,
         sync_status,
         user_id,
         created_at,
         updated_at
       )
       VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (company_id, invoice_no)
       DO UPDATE SET
         company_name = EXCLUDED.company_name,
         vendor_name = EXCLUDED.vendor_name,
         gstin = EXCLUDED.gstin,
         invoice_date = EXCLUDED.invoice_date,
         raw_json = EXCLUDED.raw_json,
         sync_status = 'pending',
         error_message = NULL,
         user_id = EXCLUDED.user_id,
         updated_at = NOW()
       RETURNING id`,
      [
        companyId,
        company?.trim(),
        customer_name || "",
        gstin || "",
        invoice_no?.trim(),
        invoice_date || "",
        JSON.stringify(invoice_data),
        "pending",
        userId
      ]
    );

    const invoiceId = insertResult.rows[0].id;
    console.log(`✅ Purchase Invoice saved: ID ${invoiceId}`);

    const { jobId } = await safeEnqueuePurchase(invoiceId, userId);

    console.log(`📤 Purchase Invoice job queued: ${jobId}`);

    return res.status(200).json({
      status: "success",
      message: "Purchase Invoice queued for processing",
      jobId,
      invoiceId,
      companyId
    });

  } catch (error) {
    console.error("❌ Push invoice error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

/* =========================================
   GET /invoices?company_id=X
   Lists every purchase invoice for a company — the "All Invoices" /
   "Review Invoices" (By Invoice) tabs' data source, mirroring
   GET /sales-invoices's shape (getSalesInvoices on the FE) so the same
   table component pattern works for both.
========================================= */
router.get("/invoices", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const companyId = validateCompanyId(req.query.company_id);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: "company_id query parameter required" });
    }

    // Optional month scope, for the Purchase Excel drill-down — an
    // invoice can only be reached this way if at least one of its
    // purchase_po_lines carries that month_label (an invoice created
    // through the manual /invoices API, with no po_lines at all, simply
    // never matches any month filter — expected, not a bug).
    const month = req.query.month?.trim();

    const result = await pool.query(
      `
      SELECT ie.id, ie.invoice_no, ie.invoice_date, ie.vendor_name, ie.gstin, ie.sync_status, ie.error_message, ie.raw_json, ie.created_at, ie.updated_at
      FROM ${DB_SCHEMA}.invoice_extractions ie
      WHERE ie.company_id = $1
        AND (
          $2::text IS NULL
          OR EXISTS (
            SELECT 1 FROM ${DB_SCHEMA}.purchase_po_lines p
            WHERE p.invoice_extraction_id = ie.id AND p.month_label = $2
          )
        )
      ORDER BY ie.created_at DESC
      `,
      [companyId, month || null]
    );

    return res.status(200).json({ status: "success", data: result.rows });
  } catch (err) {
    console.error("GET invoices error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   DELETE /invoices
   Bulk delete, body { company, invoice_ids } — the "Clear All" / per-row
   Delete action on the Review tab.

   Before deleting, resets any purchase_po_lines row this invoice fed
   back to match_status='matched' (invoice_extraction_id cleared). Without
   this, a deleted invoice's po_lines stay stuck at 'pushed' forever —
   pushMatchedLinesToInvoices only ever looks at match_status='matched',
   so the underlying PO line would never be reconsidered by any future
   upload even though its invoice_extractions row no longer exists (the
   FK's ON DELETE SET NULL clears invoice_extraction_id automatically,
   but leaves match_status alone, which is the actual gate that matters).
========================================= */
router.delete("/invoices", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }

    const companyId = await resolveCompanyIdByName(userId, company);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.purchase_po_lines
      SET match_status = 'matched', invoice_extraction_id = NULL, updated_at = NOW()
      WHERE company_id = $2 AND invoice_extraction_id = ANY($1)
      `,
      [invoice_ids, companyId]
    );

    const result = await pool.query(
      `DELETE FROM ${DB_SCHEMA}.invoice_extractions WHERE id = ANY($1) AND company_id = $2 RETURNING id`,
      [invoice_ids, companyId]
    );

    return res.status(200).json({
      status: "success",
      message: `${result.rowCount} invoice${result.rowCount === 1 ? "" : "s"} deleted successfully`,
      deleted: result.rows.map((r) => r.id)
    });
  } catch (err) {
    console.error("DELETE invoices error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   PUT /invoices/:id
   Full edit-and-retry, mirroring InvoiceReview.jsx's validateAndSync()
   payload shape (POST /invoices' invoice_data) but as an UPDATE on an
   existing row instead of an insert — the Review tab's "View" modal uses
   this to let someone fix a vendor name, GSTIN, or a line item's stock
   item name directly, then re-push, instead of only offering the
   narrower rename-across-invoices tools (resolve-missing-item/-ledger).
   Always resets sync_status to 'pending' and re-queues regardless of
   what changed — cheap, and validatePurchaseInvoice() re-runs anyway.
========================================= */
router.put("/invoices/:id", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, invoice_data } = req.body;
    const { id } = req.params;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!invoice_data) {
      return res.status(400).json({ status: "error", message: "invoice_data is required" });
    }

    const companyId = await resolveCompanyIdByName(userId, company);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    if (await rejectIfConnectorOffline(res, companyId, userId)) return;

    const existing = await pool.query(
      `SELECT id, raw_json FROM ${DB_SCHEMA}.invoice_extractions WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Invoice not found" });
    }

    const prevRawJson = typeof existing.rows[0].raw_json === "string"
      ? JSON.parse(existing.rows[0].raw_json)
      : existing.rows[0].raw_json || {};

    const {
      vendor_name, gstin, invoice_no, invoice_date, narration,
      line_items, cgst_amount, sgst_amount, igst_amount, taxable_amount, grand_total, round_off
    } = invoice_data;

    if (!vendor_name?.trim()) {
      return res.status(400).json({ status: "error", message: "vendor_name is required" });
    }
    if (!invoice_no?.trim()) {
      return res.status(400).json({ status: "error", message: "invoice_no is required" });
    }

    // Merge onto the previous raw_json rather than replacing it wholesale
    // — fields this form doesn't expose (e.g. po_numbers, tds_amount) stay
    // intact instead of silently disappearing on every edit.
    const updatedRawJson = {
      ...prevRawJson,
      vendor_name: vendor_name.trim(),
      gstin: gstin?.trim() || "",
      invoice_no: invoice_no.trim(),
      invoice_date: invoice_date || prevRawJson.invoice_date,
      narration: narration?.trim() || prevRawJson.narration,
      line_items: Array.isArray(line_items) ? line_items : prevRawJson.line_items,
      cgst_amount: cgst_amount ?? prevRawJson.cgst_amount ?? 0,
      sgst_amount: sgst_amount ?? prevRawJson.sgst_amount ?? 0,
      igst_amount: igst_amount ?? prevRawJson.igst_amount ?? 0,
      taxable_amount: taxable_amount ?? prevRawJson.taxable_amount,
      grand_total: grand_total ?? prevRawJson.grand_total,
      round_off: round_off ?? prevRawJson.round_off ?? 0
    };

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.invoice_extractions
      SET vendor_name = $1, gstin = $2, invoice_no = $3, invoice_date = $4,
          raw_json = $5, sync_status = 'pending', error_message = NULL, updated_at = NOW()
      WHERE id = $6 AND company_id = $7
      `,
      [vendor_name.trim(), gstin?.trim() || "", invoice_no.trim(), invoice_date || prevRawJson.invoice_date, updatedRawJson, id, companyId]
    );

    await safeEnqueuePurchase(Number(id), userId);

    return res.status(200).json({ status: "success", message: "Invoice updated and re-queued" });
  } catch (err) {
    console.error("PUT invoices/:id error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   GET /invoices/missing-summary
   Aggregates every purchase invoice currently blocked on a missing ledger
   or stock item, grouped by the missing entity itself (not by invoice) —
   mirrors salesInvoices.routes.js's GET /sales-invoices/missing-summary
   exactly, against invoice_extractions instead of
   sales_invoice_extractions.
========================================= */
router.get("/invoices/missing-summary", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const companyId = validateCompanyId(req.query.company_id);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: "company_id query parameter required" });
    }

    const month = req.query.month?.trim();

    const result = await pool.query(
      `
      SELECT ie.id, ie.error_message
      FROM ${DB_SCHEMA}.invoice_extractions ie
      WHERE ie.company_id = $1
        AND ie.sync_status IN ('ledger_missing', 'stock_missing', 'ledger_and_stock_missing', 'failed')
        AND ie.error_message IS NOT NULL
        AND (
          $2::text IS NULL
          OR EXISTS (
            SELECT 1 FROM ${DB_SCHEMA}.purchase_po_lines p
            WHERE p.invoice_extraction_id = ie.id AND p.month_label = $2
          )
        )
      `,
      [companyId, month || null]
    );

    const ledgerMap = new Map();
    const itemMap = new Map();

    const addTo = (map, rawName, invoiceId, details) => {
      const name = String(rawName || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { name, count: 0, invoice_ids: [], unit_of_measure: "" });
      }
      const entry = map.get(key);
      entry.count += 1;
      entry.invoice_ids.push(invoiceId);
      if (details?.unit_of_measure && !entry.unit_of_measure) {
        entry.unit_of_measure = details.unit_of_measure;
      }
    };

    for (const row of result.rows) {
      let parsed;
      try {
        parsed = JSON.parse(row.error_message);
      } catch {
        continue; // plain-text error (e.g. a connector/Tally-side failure), not a validation JSON blob
      }

      for (const l of parsed.missing_ledgers || []) {
        addTo(ledgerMap, l.ledger || l.name || l, row.id);
      }
      for (const itemName of parsed.missing_stock_items || []) {
        addTo(itemMap, itemName, row.id, parsed.missing_stock_item_details?.[itemName]);
      }
    }

    const missingItemNames = [...itemMap.values()];
    const missingLedgerNames = [...ledgerMap.values()];

    if (missingItemNames.length) {
      const knownNamesResult = await pool.query(
        `
        SELECT item_name FROM ${DB_SCHEMA}.stock_group_summary WHERE company_id = $1
        UNION
        SELECT item_name FROM ${DB_SCHEMA}.push_stock_item WHERE company_id = $1 AND status = 'success'
        `,
        [companyId]
      );
      const knownNames = knownNamesResult.rows.map((r) => r.item_name).filter(Boolean);

      for (const entry of missingItemNames) {
        const candidates = knownNames.filter(
          (n) => n.trim().toLowerCase() !== entry.name.trim().toLowerCase()
        );
        entry.suggestions = findTopItemMatches(candidates, entry.name, { minScore: 0.9 });
      }
    }

    // Real creation status, from the same table the "+ Create Item"/"New
    // Ledger" modals themselves write to — not inferred from the parent
    // invoice's sync_status or the frontend's own unsaved checkbox
    // selection (that heuristic is what made the "Missing" table keep
    // showing "Not created" for items that had, in fact, already been
    // pushed successfully).
    if (missingItemNames.length) {
      const pushedItemsResult = await pool.query(
        `SELECT DISTINCT LOWER(TRIM(item_name)) AS name
         FROM ${DB_SCHEMA}.push_stock_item
         WHERE company_id = $1 AND status = 'success'`,
        [companyId]
      );
      const pushedItemNames = new Set(pushedItemsResult.rows.map((r) => r.name));
      for (const entry of missingItemNames) {
        entry.created = pushedItemNames.has(entry.name.trim().toLowerCase());
      }
    }

    if (missingLedgerNames.length) {
      const pushedLedgersResult = await pool.query(
        `SELECT DISTINCT LOWER(TRIM(ledger_name)) AS name
         FROM ${DB_SCHEMA}.push_ledger
         WHERE company_id = $1 AND status = 'success'`,
        [companyId]
      );
      const pushedLedgerNames = new Set(pushedLedgersResult.rows.map((r) => r.name));
      for (const entry of missingLedgerNames) {
        entry.created = pushedLedgerNames.has(entry.name.trim().toLowerCase());
      }
    }

    return res.status(200).json({
      status: "success",
      missing_ledgers: missingLedgerNames.sort((a, b) => b.count - a.count),
      missing_stock_items: missingItemNames.sort((a, b) => b.count - a.count)
    });
  } catch (err) {
    console.error("GET invoices/missing-summary error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   POST /invoices/retry-batch
   Re-queues previously-failed purchase invoices unchanged — used after
   creating a missing ledger/stock item in Tally, to clear everything that
   was blocked on it in one action.
========================================= */
router.post("/invoices/retry-batch", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }
    if (invoice_ids.some((id) => isNaN(Number(id)))) {
      return res.status(400).json({ status: "error", message: "All invoice ids must be valid numbers" });
    }

    const companyId = await resolveCompanyIdByName(userId, company);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    if (await rejectIfConnectorOffline(res, companyId, userId)) return;

    const existing = await pool.query(
      `SELECT id FROM ${DB_SCHEMA}.invoice_extractions WHERE id = ANY($1) AND company_id = $2`,
      [invoice_ids, companyId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "No matching invoices found for this company" });
    }

    const results = [];
    for (const row of existing.rows) {
      await pool.query(
        `UPDATE ${DB_SCHEMA}.invoice_extractions SET sync_status = 'pending', error_message = NULL, updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await safeEnqueuePurchase(row.id, userId);
      results.push({ id: row.id, status: "queued" });
    }

    return res.status(200).json({
      status: "success",
      message: `${results.length} of ${invoice_ids.length} invoice(s) re-queued`,
      results
    });
  } catch (err) {
    console.error("POST invoices/retry-batch error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   POST /invoices/resolve-missing-item
   Renames a missing item name to a real, existing stock item name across
   every affected invoice's stored line_items, then re-queues them —
   unlike retry-batch, this edits raw_json first since retrying with the
   same wrong name would only fail the same way again.
========================================= */
router.post("/invoices/resolve-missing-item", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, wrong_name, correct_name, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!String(wrong_name || "").trim() || !String(correct_name || "").trim()) {
      return res.status(400).json({ status: "error", message: "wrong_name and correct_name are required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }

    const companyId = await resolveCompanyIdByName(userId, company);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    if (await rejectIfConnectorOffline(res, companyId, userId)) return;

    const existing = await pool.query(
      `SELECT id, raw_json FROM ${DB_SCHEMA}.invoice_extractions WHERE id = ANY($1) AND company_id = $2`,
      [invoice_ids, companyId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "No matching invoices found for this company" });
    }

    const wrongNameLower = String(wrong_name).trim().toLowerCase();
    const results = [];

    for (const row of existing.rows) {
      try {
        const rawJson = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
        const lineItems = Array.isArray(rawJson?.line_items) ? rawJson.line_items : [];

        let renamed = 0;
        for (const item of lineItems) {
          if (String(item.item_name || "").trim().toLowerCase() === wrongNameLower) {
            item.item_name = correct_name;
            renamed++;
          }
        }

        if (renamed === 0) {
          results.push({ id: row.id, status: "skipped", message: "item name not found on this invoice" });
          continue;
        }

        await pool.query(
          `UPDATE ${DB_SCHEMA}.invoice_extractions SET raw_json = $1, sync_status = 'pending', error_message = NULL, updated_at = NOW() WHERE id = $2`,
          [rawJson, row.id]
        );
        await safeEnqueuePurchase(row.id, userId);
        results.push({ id: row.id, status: "queued" });
      } catch (err) {
        console.error(`resolve-missing-item: failed for invoice ${row.id}:`, err.message);
        results.push({ id: row.id, status: "error", message: err.message });
      }
    }

    return res.status(200).json({
      status: "success",
      message: `${results.filter((r) => r.status === "queued").length} of ${invoice_ids.length} invoice(s) updated and re-queued`,
      results
    });
  } catch (err) {
    console.error("POST invoices/resolve-missing-item error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   POST /invoices/resolve-missing-ledger
   Purchase-specific companion to resolve-missing-item — the party ledger
   itself was wrong/unmapped (e.g. a vendor whose Tally ledger doesn't
   exist under this exact name yet). Corrects vendor_name on every
   affected invoice and re-queues.
========================================= */
router.post("/invoices/resolve-missing-ledger", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, wrong_name, correct_name, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!String(wrong_name || "").trim() || !String(correct_name || "").trim()) {
      return res.status(400).json({ status: "error", message: "wrong_name and correct_name are required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }

    const companyId = await resolveCompanyIdByName(userId, company);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    if (await rejectIfConnectorOffline(res, companyId, userId)) return;

    const existing = await pool.query(
      `SELECT id, raw_json FROM ${DB_SCHEMA}.invoice_extractions WHERE id = ANY($1) AND company_id = $2`,
      [invoice_ids, companyId]
    );

    const results = [];
    for (const row of existing.rows) {
      const rawJson = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
      if (rawJson) rawJson.vendor_name = correct_name;

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.invoice_extractions
        SET raw_json = $1, vendor_name = $2, sync_status = 'pending', error_message = NULL, updated_at = NOW()
        WHERE id = $3
        `,
        [rawJson, correct_name, row.id]
      );
      await safeEnqueuePurchase(row.id, userId);
      results.push({ id: row.id, status: "queued" });
    }

    return res.status(200).json({
      status: "success",
      message: `${results.length} of ${invoice_ids.length} invoice(s) updated and re-queued`,
      results
    });
  } catch (err) {
    console.error("POST invoices/resolve-missing-ledger error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;