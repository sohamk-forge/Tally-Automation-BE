/**
 * Audit Purchase Excel invoices already pushed to Tally against the
 * current billing rules (src/services/purchaseExcelBilling.js) and
 * optionally re-push the wrong ones.
 *
 * Usage (from Tally-Automation-BE):
 *   node scripts/audit-purchase-excel-billing.js [--company <id>]
 *   node scripts/audit-purchase-excel-billing.js --company <id> --repush <invoiceNo>[,<invoiceNo>...]
 *
 * Audit (default, read-only): for every invoice whose lines are 'pushed',
 * rebuilds the invoice with today's rules and lists the ones whose
 * quantity / total differ from what was pushed, or that would now be
 * held for review. Lines uploaded before the Vendor Invoice Qty. / VECV
 * Invoice Net Val columns were stored are listed as "re-upload needed" —
 * re-upload that month's Purchase Report first (the upsert fills the new
 * columns on already-pushed lines without changing their status).
 *
 * --repush: sets the given invoices' lines back to 'matched' and pushes
 * them again through the normal pipeline. generator.py creates vouchers
 * with ACTION="Create", so DELETE THE OLD VOUCHER IN TALLY FIRST or Tally
 * will hold both.
 */
import "dotenv/config";
import pool from "../src/db/index.js";
import { buildPurchaseExcelInvoice, checkPurchaseExcelInvoice } from "../src/services/purchaseExcelBilling.js";

const S = "app_test";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function audit(companyFilter) {
  const lines = (await pool.query(
    `
    SELECT p.*, ie.raw_json, ie.sync_status
    FROM ${S}.purchase_po_lines p
    LEFT JOIN ${S}.invoice_extractions ie ON ie.id = p.invoice_extraction_id
    WHERE p.match_status = 'pushed' AND ($1::int IS NULL OR p.company_id = $1)
    ORDER BY p.company_id, p.invoice_no, p.po_no, p.po_line_item
    `,
    [companyFilter ?? null]
  )).rows;

  const groups = new Map();
  for (const l of lines) {
    const key = `${l.company_id}|${l.invoice_no}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(l);
  }

  const wrong = [];
  const reupload = [];
  for (const [key, group] of groups) {
    const [companyId, invoiceNo] = key.split("|");
    if (group.some((l) => l.vendor_invoice_qty === null && l.vendor_invoice_net_val === null)) {
      reupload.push({ company: companyId, invoice: invoiceNo, month: group[0].month_label });
      continue;
    }

    const pushed = typeof group[0].raw_json === "string" ? JSON.parse(group[0].raw_json) : group[0].raw_json || {};
    const now = buildPurchaseExcelInvoice(invoiceNo, group, { purchaseLedger: pushed.purchase_ledger });
    const held = checkPurchaseExcelInvoice(now);

    const pushedQty = (pushed.line_items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
    const nowQty = now.line_items.reduce((s, i) => s + Number(i.qty || 0), 0);
    const pushedTotal = Number(pushed.grand_total || 0);

    if (held.length || pushedQty !== nowQty || Math.abs(pushedTotal - now.grand_total) > 1) {
      wrong.push({
        company: companyId,
        invoice: invoiceNo,
        vendor: group[0].vendor_name,
        pushed_qty: pushedQty,
        correct_qty: nowQty,
        pushed_total: pushedTotal,
        correct_total: now.grand_total,
        tally_status: group[0].sync_status,
        note: held.join("; ")
      });
    }
  }

  console.log(`\nChecked ${groups.size} pushed invoice(s).`);
  console.log(`\n${wrong.length} invoice(s) pushed with the wrong qty/total (or that would now be held):`);
  if (wrong.length) console.table(wrong);
  console.log(`\n${reupload.length} invoice(s) need the Purchase Report re-uploaded before they can be checked:`);
  if (reupload.length) {
    const byMonth = {};
    reupload.forEach((r) => { byMonth[`${r.company} / ${r.month || "(no month)"}`] = (byMonth[`${r.company} / ${r.month || "(no month)"}`] || 0) + 1; });
    console.table(Object.entries(byMonth).map(([k, n]) => ({ "company / month": k, invoices: n })));
  }
}

async function repush(companyId, invoiceNos) {
  // Imported here so a plain audit never opens a Redis/BullMQ connection.
  const { pushMatchedLinesToInvoices } = await import("../src/services/purchaseExcelPush.service.js");
  const { purchaseQueue } = await import("../src/queues/purchase.queue.js");

  const reset = await pool.query(
    `
    UPDATE ${S}.purchase_po_lines
    SET match_status = 'matched', updated_at = NOW()
    WHERE company_id = $1 AND invoice_no = ANY($2) AND match_status = 'pushed'
    RETURNING invoice_no
    `,
    [companyId, invoiceNos]
  );
  const found = [...new Set(reset.rows.map((r) => r.invoice_no))];
  const missing = invoiceNos.filter((n) => !found.includes(n));
  if (missing.length) console.warn(`Not found as pushed lines for company ${companyId}: ${missing.join(", ")}`);

  const pushed = await pushMatchedLinesToInvoices(companyId);
  console.log(`Re-queued ${pushed.length} invoice(s):`);
  console.table(pushed);
  await purchaseQueue.close();
}

try {
  const company = arg("--company") ? Number(arg("--company")) : undefined;
  const repushList = arg("--repush");
  if (repushList) {
    if (!company) throw new Error("--repush needs --company <id>");
    await repush(company, repushList.split(",").map((s) => s.trim()).filter(Boolean));
  } else {
    await audit(company);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit();
}
