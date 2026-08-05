/**
 * src/services/quotation.service.js
 *
 * Quotation numbers: 0001, 0002, 0003 ...
 * - No prefix
 * - Starts from 0001 automatically
 * - If DB is cleared, resets to 0001
 * - User never inputs the number
 *
 * No settings table needed — next number is derived from
 * MAX(quotation_seq) on the quotations table itself, guarded by a
 * Postgres transaction-scoped advisory lock (per company_id) so two
 * concurrent creates can't grab the same number.
 *
 * GST handling: gst_enabled is read once per create from
 * ${DB_SCHEMA}.company_details and applied to every line item.
 */

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUOTATION_PAD_LENGTH = 4; // 0001, 0002, ...

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((+n + Number.EPSILON) * 100) / 100;
}

function toNum(v, fallback = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function normalizeDate(v) {
  if (v === undefined || v === null) return null;
  const trimmed = String(v).trim();
  return trimmed === "" ? null : trimmed;
}

function formatQuotationNo(seq) {
  return String(seq).padStart(QUOTATION_PAD_LENGTH, "0");
}

function computeItem(item, supplyType = "intrastate", gstEnabled = true) {
  const qty        = toNum(item.qty);
  const rate       = toNum(item.rate);
  const discPct    = toNum(item.discount_percent);

  const grossAmt   = round2(qty * rate);
  const discAmt    = round2(grossAmt * discPct / 100);
  const taxableAmt = round2(grossAmt - discAmt);

  if (!gstEnabled) {
    return {
      item_name:        String(item.item_name || "").trim(),
      godown_name:      String(item.godown_name || "").trim() || null,
      bin:              String(item.bin || "").trim() || null,
      hsn_code:         String(item.hsn_code   || "").trim() || null,
      qty,
      rate,
      gst_rate:         "0%",
      discount_percent: discPct,
      taxable_amount:   taxableAmt,
      cgst_amount:      0,
      sgst_amount:      0,
      igst_amount:      0,
      line_total:       taxableAmt,
      sort_order:       toNum(item.sort_order, 0),
    };
  }

  const gstRateStr = String(item.gst_rate || "0%").replace("%", "");
  const gstRate    = toNum(gstRateStr);
  const totalTax   = round2(taxableAmt * gstRate / 100);

  let cgst = 0, sgst = 0, igst = 0;
  if (supplyType === "interstate") {
    igst = totalTax;
  } else {
    cgst = round2(totalTax / 2);
    sgst = round2(totalTax / 2);
  }

  return {
    item_name:        String(item.item_name || "").trim(),
    godown_name:      String(item.godown_name || "").trim() || null,
    bin:              String(item.bin || "").trim() || null,
    hsn_code:         String(item.hsn_code   || "").trim() || null,
    qty,
    rate,
    gst_rate:         `${gstRate}%`,
    discount_percent: discPct,
    taxable_amount:   taxableAmt,
    cgst_amount:      cgst,
    sgst_amount:      sgst,
    igst_amount:      igst,
    line_total:       round2(taxableAmt + totalTax),
    sort_order:       toNum(item.sort_order, 0),
  };
}

function computeTotals(computedItems) {
  let subTotal = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0;
  for (const it of computedItems) {
    subTotal  += it.taxable_amount;
    totalCgst += it.cgst_amount;
    totalSgst += it.sgst_amount;
    totalIgst += it.igst_amount;
  }
  const totalTax   = round2(totalCgst + totalSgst + totalIgst);
  const grandTotal = round2(subTotal + totalTax);
  return {
    sub_total:   round2(subTotal),
    total_cgst:  round2(totalCgst),
    total_sgst:  round2(totalSgst),
    total_igst:  round2(totalIgst),
    total_tax:   totalTax,
    grand_total: grandTotal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: allocateNextQuotationNumber  (runs inside transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function allocateNextQuotationNumber(client, companyId) {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [companyId]);

  const maxRes = await client.query(
    `SELECT COALESCE(MAX(quotation_seq), 0) AS max_seq
     FROM ${DB_SCHEMA}.quotations
     WHERE company_id = $1`,
    [companyId]
  );

  const nextSeq = Number(maxRes.rows[0].max_seq) + 1;
  return { quotationNo: formatQuotationNo(nextSeq), seq: nextSeq };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: getGstEnabled  (runs inside transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function getGstEnabled(client, companyId) {
  const res = await client.query(
    `SELECT gst_enabled FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
    [companyId]
  );
  return res.rows[0]?.gst_enabled ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: peekNextQuotationNumber
// Read-only — does NOT allocate. Used by GET /api/v1/quotation/next-number
// ─────────────────────────────────────────────────────────────────────────────

export async function peekNextQuotationNumber(companyId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(quotation_seq), 0) AS max_seq
     FROM ${DB_SCHEMA}.quotations
     WHERE company_id = $1`,
    [companyId]
  );

  const currentSeq = Number(result.rows[0].max_seq);
  return {
    next_quotation_number: formatQuotationNo(currentSeq + 1),
    current_seq: currentSeq,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createQuotation
// ─────────────────────────────────────────────────────────────────────────────

export async function createQuotation(data) {
  const {
    company_id,
    customer_name    = null,
    customer_gstin   = null,
    customer_address = null,
    terms_conditions = null,
    supply_type      = "intrastate",
    items            = [],
  } = data;

  const quotation_date = normalizeDate(data.quotation_date);
  const valid_until     = normalizeDate(data.valid_until);

  let company_name = data.company_name || null;

  if (!company_id)      throw new Error("company_id is required");
  if (!quotation_date)  throw new Error("quotation_date is required");
  if (!items.length)    throw new Error("At least one item is required");

  for (const [i, item] of items.entries()) {
    if (!item.item_name) throw new Error(`Item at index ${i} is missing item_name`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!company_name) {
      const compRes = await client.query(
        `SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`,
        [company_id]
      );
      if (compRes.rows.length) company_name = compRes.rows[0].name;
    }

    // Determine GST status once, apply to every line item
    const gstEnabled = await getGstEnabled(client, company_id);

    const computedItems = items.map((it) => computeItem(it, supply_type, gstEnabled));
    const totals        = computeTotals(computedItems);

    // Atomically claim next number (0001, 0002, ...)
    const { quotationNo, seq } = await allocateNextQuotationNumber(client, company_id);

    // Insert quotation header
    const quotationRes = await client.query(
      `INSERT INTO ${DB_SCHEMA}.quotations (
        company_id, company_name, quotation_number, quotation_seq,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        sub_total, total_cgst, total_sgst, total_igst, total_tax, grand_total,
        terms_conditions, status
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,$9,
        $10,$11,$12,$13,$14,$15,
        $16,'DRAFT'
      ) RETURNING *`,
      [
        company_id, company_name, quotationNo, seq,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        totals.sub_total, totals.total_cgst, totals.total_sgst,
        totals.total_igst, totals.total_tax, totals.grand_total,
        terms_conditions,
      ]
    );

    const quotation   = quotationRes.rows[0];
    const quotationId = quotation.id;

    // Insert line items
    const insertedItems = [];
    for (const [idx, it] of computedItems.entries()) {
      const itemRes = await client.query(
        `INSERT INTO ${DB_SCHEMA}.quotation_items (
          quotation_id, item_name, godown_name, bin, hsn_code,
          qty, rate, gst_rate, discount_percent,
          taxable_amount, cgst_amount, sgst_amount, igst_amount,
          line_total, sort_order
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,
          $10,$11,$12,$13,
          $14,$15
        ) RETURNING *`,
        [
          quotationId, it.item_name, it.godown_name, it.bin, it.hsn_code,
          it.qty, it.rate, it.gst_rate, it.discount_percent,
          it.taxable_amount, it.cgst_amount, it.sgst_amount, it.igst_amount,
          it.line_total, idx,
        ]
      );
      insertedItems.push(itemRes.rows[0]);
    }

    await client.query("COMMIT");
    return { ...quotation, items: insertedItems, gst_enabled: gstEnabled };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getAllQuotations
//
// Returns items[] and item_count per quotation via a LATERAL join +
// json_agg, so the list view can render everything the frontend needs
// without a second round-trip per row.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllQuotations(companyId, filters = {}) {
  const conditions = ["q.company_id = $1"];
  const values     = [companyId];
  let   idx        = 2;

  if (filters.status) {
    conditions.push(`q.status = $${idx++}`);
    values.push(filters.status.toUpperCase());
  }
  if (filters.from_date) {
    conditions.push(`q.quotation_date >= $${idx++}`);
    values.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`q.quotation_date <= $${idx++}`);
    values.push(filters.to_date);
  }
  if (filters.customer_name) {
    conditions.push(`q.customer_name ILIKE $${idx++}`);
    values.push(`%${filters.customer_name}%`);
  }

  const quotationRes = await pool.query(
    `SELECT
       q.*,
       COALESCE(items.item_count, 0)   AS item_count,
       COALESCE(items.items, '[]'::json) AS items
     FROM ${DB_SCHEMA}.quotations q
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*)::int AS item_count,
         json_agg(
           json_build_object(
             'id',                qi.id,
             'item_name',         qi.item_name,
             'godown_name',       qi.godown_name,
             'bin',               qi.bin,
             'hsn_code',          qi.hsn_code,
             'qty',               qi.qty,
             'rate',              qi.rate,
             'gst_rate',          qi.gst_rate,
             'discount_percent',  qi.discount_percent,
             'taxable_amount',    qi.taxable_amount,
             'cgst_amount',       qi.cgst_amount,
             'sgst_amount',       qi.sgst_amount,
             'igst_amount',       qi.igst_amount,
             'line_total',        qi.line_total,
             'sort_order',        qi.sort_order
           ) ORDER BY qi.sort_order ASC, qi.id ASC
         ) AS items
       FROM ${DB_SCHEMA}.quotation_items qi
       WHERE qi.quotation_id = q.id
     ) items ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY q.quotation_seq DESC`,
    values
  );

  return quotationRes.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getQuotationById
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuotationById(quotationId, companyId) {
  const quotationRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.quotations WHERE id = $1 AND company_id = $2`,
    [quotationId, companyId]
  );
  if (!quotationRes.rows.length) return null;

  const itemsRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.quotation_items
     WHERE quotation_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [quotationId]
  );

  const gstStatusRes = await pool.query(
    `SELECT gst_enabled FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
    [companyId]
  );
  const gstEnabled = gstStatusRes.rows[0]?.gst_enabled ?? false;

  return { ...quotationRes.rows[0], items: itemsRes.rows, gst_enabled: gstEnabled };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: updateQuotationStatus
// ─────────────────────────────────────────────────────────────────────────────

export async function updateQuotationStatus(quotationId, companyId, status) {
  const allowed = ["DRAFT", "FINAL", "PUSHED_TO_TALLY", "CANCELLED"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status. Allowed: ${allowed.join(", ")}`);
  }

  const result = await pool.query(
    `UPDATE ${DB_SCHEMA}.quotations
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [status, quotationId, companyId]
  );

  return result.rows[0] || null;
}