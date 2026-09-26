/**
 * src/services/proforma.service.js
 *
 * Proforma invoice numbers: 0001, 0002, ... own sequence, no prefix, same
 * "MAX + advisory lock" pattern as quotations.
 *
 * A proforma invoice is always created FROM a quotation (any version).
 * Line items and totals are copied over and can be overridden before
 * saving (e.g. the sales team tweaks a rate before sending it out).
 */

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const PAD_LENGTH = 4;

// Advisory locks share one 64-bit keyspace across the whole DB, so we salt
// each resource's lock key to avoid colliding with the quotation lock that
// also uses company_id.
const LOCK_SALT = 900000000;

function formatNo(seq) {
  return String(seq).padStart(PAD_LENGTH, "0");
}

function normalizeDate(v) {
  if (v === undefined || v === null) return null;
  const trimmed = String(v).trim();
  return trimmed === "" ? null : trimmed;
}

async function allocateNextNumber(client, companyId) {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [companyId + LOCK_SALT]);

  const res = await client.query(
    `SELECT COALESCE(MAX(proforma_seq), 0) AS max_seq
     FROM ${DB_SCHEMA}.proforma_invoices
     WHERE company_id = $1`,
    [companyId]
  );
  const nextSeq = Number(res.rows[0].max_seq) + 1;
  return { proformaNo: formatNo(nextSeq), seq: nextSeq };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: peekNextProformaNumber
// ─────────────────────────────────────────────────────────────────────────────

export async function peekNextProformaNumber(companyId) {
  const res = await pool.query(
    `SELECT COALESCE(MAX(proforma_seq), 0) AS max_seq
     FROM ${DB_SCHEMA}.proforma_invoices
     WHERE company_id = $1`,
    [companyId]
  );
  const currentSeq = Number(res.rows[0].max_seq);
  return { next_proforma_number: formatNo(currentSeq + 1), current_seq: currentSeq };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createProformaFromQuotation
// ─────────────────────────────────────────────────────────────────────────────

export async function createProformaFromQuotation(quotationId, companyId, overrides = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const qRes = await client.query(
      `SELECT * FROM ${DB_SCHEMA}.quotations WHERE id = $1 AND company_id = $2`,
      [quotationId, companyId]
    );
    if (!qRes.rows.length) throw new Error("Quotation not found");
    const quotation = qRes.rows[0];

    let itemsRows = overrides.items;
    if (!itemsRows || !itemsRows.length) {
      const itemsRes = await client.query(
        `SELECT * FROM ${DB_SCHEMA}.quotation_items WHERE quotation_id = $1 ORDER BY sort_order ASC, id ASC`,
        [quotationId]
      );
      itemsRows = itemsRes.rows;
    }
    if (!itemsRows.length) throw new Error("At least one item is required");

    const proforma_date    = normalizeDate(overrides.proforma_date) || new Date().toISOString().slice(0, 10);
    const valid_until      = normalizeDate(overrides.valid_until)   ?? quotation.valid_until;
    const customer_name    = overrides.customer_name    ?? quotation.customer_name;
    const customer_gstin   = overrides.customer_gstin   ?? quotation.customer_gstin;
    const customer_address = overrides.customer_address ?? quotation.customer_address;
    const terms_conditions = overrides.terms_conditions ?? quotation.terms_conditions;

    // Recompute totals from the (possibly overridden) items so the proforma
    // is never silently out of sync with its own line items.
    let subTotal = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0;
    for (const it of itemsRows) {
      subTotal  += Number(it.taxable_amount) || 0;
      totalCgst += Number(it.cgst_amount) || 0;
      totalSgst += Number(it.sgst_amount) || 0;
      totalIgst += Number(it.igst_amount) || 0;
    }
    const totalTax   = Math.round((totalCgst + totalSgst + totalIgst) * 100) / 100;
    const grandTotal = Math.round((subTotal + totalTax) * 100) / 100;

    const { proformaNo, seq } = await allocateNextNumber(client, companyId);

    const insertRes = await client.query(
      `INSERT INTO ${DB_SCHEMA}.proforma_invoices (
        company_id, company_name, proforma_number, proforma_seq, quotation_id,
        proforma_date, valid_until, customer_name, customer_gstin, customer_address,
        sub_total, total_cgst, total_sgst, total_igst, total_tax, grand_total,
        terms_conditions, status
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,
        $17,'DRAFT'
      ) RETURNING *`,
      [
        companyId, quotation.company_name, proformaNo, seq, quotationId,
        proforma_date, valid_until, customer_name, customer_gstin, customer_address,
        Math.round(subTotal * 100) / 100, Math.round(totalCgst * 100) / 100,
        Math.round(totalSgst * 100) / 100, Math.round(totalIgst * 100) / 100,
        totalTax, grandTotal, terms_conditions,
      ]
    );

    const proforma   = insertRes.rows[0];
    const proformaId = proforma.id;

    const insertedItems = [];
    for (const [idx, it] of itemsRows.entries()) {
      const itemRes = await client.query(
        `INSERT INTO ${DB_SCHEMA}.proforma_invoice_items (
          proforma_invoice_id, item_name, godown_name, bin, hsn_code, unit,
          qty, rate, gst_rate, discount_percent,
          taxable_amount, cgst_amount, sgst_amount, igst_amount,
          line_total, sort_order
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,
          $15,$16
        ) RETURNING *`,
        [
          proformaId, it.item_name, it.godown_name, it.bin, it.hsn_code, it.unit,
          it.qty, it.rate, it.gst_rate, it.discount_percent,
          it.taxable_amount, it.cgst_amount, it.sgst_amount, it.igst_amount,
          it.line_total, idx,
        ]
      );
      insertedItems.push(itemRes.rows[0]);
    }

    await client.query("COMMIT");
    return { ...proforma, items: insertedItems };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getAllProformaInvoices
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllProformaInvoices(companyId, filters = {}) {
  const conditions = ["p.company_id = $1"];
  const values     = [companyId];
  let   idx        = 2;

  if (filters.status) {
    conditions.push(`p.status = $${idx++}`);
    values.push(filters.status.toUpperCase());
  }
  if (filters.customer_name) {
    conditions.push(`p.customer_name ILIKE $${idx++}`);
    values.push(`%${filters.customer_name}%`);
  }

  const res = await pool.query(
    `SELECT
       p.*,
       COALESCE(items.item_count, 0)     AS item_count,
       COALESCE(items.items, '[]'::json) AS items
     FROM ${DB_SCHEMA}.proforma_invoices p
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS item_count, json_agg(pi ORDER BY pi.sort_order ASC, pi.id ASC) AS items
       FROM ${DB_SCHEMA}.proforma_invoice_items pi
       WHERE pi.proforma_invoice_id = p.id
     ) items ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY p.proforma_seq DESC`,
    values
  );
  return res.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getProformaInvoiceById
// ─────────────────────────────────────────────────────────────────────────────

export async function getProformaInvoiceById(proformaId, companyId) {
  const pRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.proforma_invoices WHERE id = $1 AND company_id = $2`,
    [proformaId, companyId]
  );
  if (!pRes.rows.length) return null;

  const itemsRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.proforma_invoice_items
     WHERE proforma_invoice_id = $1 ORDER BY sort_order ASC, id ASC`,
    [proformaId]
  );

  return { ...pRes.rows[0], items: itemsRes.rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: updateProformaStatus
// ─────────────────────────────────────────────────────────────────────────────

export async function updateProformaStatus(proformaId, companyId, status) {
  const allowed = ["DRAFT", "SENT", "CONVERTED", "CANCELLED"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status. Allowed: ${allowed.join(", ")}`);
  }

  const result = await pool.query(
    `UPDATE ${DB_SCHEMA}.proforma_invoices
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [status, proformaId, companyId]
  );
  return result.rows[0] || null;
}