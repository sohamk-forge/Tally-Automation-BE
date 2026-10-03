import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { safeEnqueuePurchase } from "../queues/purchase.queue.js";
import { buildPurchaseExcelInvoice } from "./purchaseExcelBilling.js";

/* =====================================================================
   SHARED: group every 'matched' purchase_po_lines row by invoice_no,
   upsert into invoice_extractions, hand off to the existing push
   pipeline, mark 'pushed'. Self-contained (derives userId per group from
   the rows themselves) so it can also run as startup recovery with no
   job context at all.
   ===================================================================== */
export async function pushMatchedLinesToInvoices(companyId) {
  const linesResult = await pool.query(
    `
    SELECT * FROM ${DB_SCHEMA}.purchase_po_lines
    WHERE company_id = $1 AND match_status = 'matched'
    ORDER BY invoice_no, po_no, po_line_item
    `,
    [companyId]
  );

  if (!linesResult.rows.length) return [];

  // Every Purchase Excel invoice is posted to the ledger the company picked
  // (Purchase Accounts group). With none picked, hold the matched lines
  // instead of pushing invoices that would fail in Tally — they go out as
  // soon as a ledger is saved (see PUT /bulk-purchase-upload/purchase-ledger).
  const ledgerResult = await pool.query(
    `SELECT purchase_excel_ledger FROM ${DB_SCHEMA}.company_ledger_mappings WHERE company_id = $1`,
    [companyId]
  );
  const purchaseLedger = ledgerResult.rows[0]?.purchase_excel_ledger?.trim();

  if (!purchaseLedger) {
    console.warn(`[BULK-PURCHASE] Holding ${linesResult.rows.length} matched line(s) for company ${companyId} — no Purchase Excel ledger selected yet`);
    return [];
  }

  const companyResult = await pool.query(`SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`, [companyId]);
  const companyName = companyResult.rows[0]?.name || "";

  const gstinResult = await pool.query(
    `SELECT vendor_code, gstin FROM ${DB_SCHEMA}.vendor_gstin_mappings WHERE company_id = $1`,
    [companyId]
  );
  const gstinByVendorCode = {};
  gstinResult.rows.forEach((r) => { gstinByVendorCode[r.vendor_code] = r.gstin; });

  const byInvoice = {};
  linesResult.rows.forEach((line) => {
    (byInvoice[line.invoice_no] = byInvoice[line.invoice_no] || []).push(line);
  });

  const pushedInvoices = [];

  for (const [invoiceNo, lines] of Object.entries(byInvoice)) {
    const first = lines[0];
    const userId = first.user_id;

    if (!userId) {
      console.warn(`[BULK-PURCHASE] Skipping invoice ${invoiceNo} for company ${companyId} — no user_id on file`);
      continue;
    }

    const vendorGstin = gstinByVendorCode[first.vendor_code] || "";

    // Qty/amount/tax/total all come from services/purchaseExcelBilling.js.
    // An invoice with review_reasons is still saved (so it shows on the
    // Review tab with its reason) but pushInvoice.worker.js holds it as
    // Needs Review instead of sending it to Tally.
    const invoiceData = buildPurchaseExcelInvoice(invoiceNo, lines, { purchaseLedger, vendorGstin });
    if (invoiceData.review_reasons.length) {
      console.warn(`[BULK-PURCHASE] Invoice ${invoiceNo} will be held for review:`, invoiceData.review_reasons);
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
      [companyId, companyName, first.vendor_name, vendorGstin, invoiceNo, first.invoice_date, JSON.stringify(invoiceData), userId]
    );

    const invoiceId = insertResult.rows[0].id;

    await safeEnqueuePurchase(invoiceId, userId);

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.purchase_po_lines
      SET match_status = 'pushed', invoice_extraction_id = $1, updated_at = NOW()
      WHERE company_id = $2 AND invoice_no = $3 AND match_status = 'matched'
      `,
      [invoiceId, companyId, invoiceNo]
    );

    pushedInvoices.push({ invoiceNo, invoiceId, lineCount: lines.length });
  }

  return pushedInvoices;
}
