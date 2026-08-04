/**
 * src/services/challan.service.js
 *
 * Challan numbers: 0001, 0002, 0003 ...
 * - No prefix
 * - Starts from 0001 automatically
 * - If DB is cleared, resets to 0001
 * - User never inputs the number
 */

import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHALLAN_PAD_LENGTH = 4; // 0001, 0002, ...

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

function formatChallanNo(seq) {
  return String(seq).padStart(CHALLAN_PAD_LENGTH, "0");
}

function computeItem(item, supplyType = "intrastate") {
  const qty        = toNum(item.qty);
  const rate       = toNum(item.rate);
  const discPct    = toNum(item.discount_percent);
  const gstRateStr = String(item.gst_rate || "0%").replace("%", "");
  const gstRate    = toNum(gstRateStr);

  const grossAmt   = round2(qty * rate);
  const discAmt    = round2(grossAmt * discPct / 100);
  const taxableAmt = round2(grossAmt - discAmt);
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
// INTERNAL: getOrInitSettings  (runs inside transaction, row-locked)
// Auto-creates settings row if missing.
// If DB was cleared (no challans), resets to 0 so next = 0001.
// ─────────────────────────────────────────────────────────────────────────────

async function getOrInitSettings(client, companyId) {
  // Try to get existing row with lock
  const settingsRes = await client.query(
    `SELECT * FROM ${DB_SCHEMA}.challan_settings
     WHERE company_id = $1
     FOR UPDATE`,
    [companyId]
  );

  if (settingsRes.rows.length) {
    // Settings exist — but check if challans table was cleared
    // If last_number > 0 but no challans exist, reset counter to 0
    const challanCount = await client.query(
      `SELECT COUNT(*) FROM ${DB_SCHEMA}.challans WHERE company_id = $1`,
      [companyId]
    );

    const count = parseInt(challanCount.rows[0].count, 10);

    if (count === 0 && Number(settingsRes.rows[0].last_number) > 0) {
      // DB was cleared — reset counter back to 0 so next challan = 0001
      const resetRes = await client.query(
        `UPDATE ${DB_SCHEMA}.challan_settings
         SET last_number = 0, updated_at = NOW()
         WHERE company_id = $1
         RETURNING *`,
        [companyId]
      );
      return resetRes.rows[0];
    }

    return settingsRes.rows[0];
  }

  // No settings row yet — create fresh starting from 0
  const insertRes = await client.query(
    `INSERT INTO ${DB_SCHEMA}.challan_settings
       (company_id, prefix, pad_length, last_number, updated_at)
     VALUES ($1, '', $2, 0, NOW())
     RETURNING *`,
    [companyId, CHALLAN_PAD_LENGTH]
  );

  return insertRes.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: allocateNextChallanNumber  (runs inside transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function allocateNextChallanNumber(client, companyId) {
  const settings = await getOrInitSettings(client, companyId);
  const nextSeq  = Number(settings.last_number) + 1;

  await client.query(
    `UPDATE ${DB_SCHEMA}.challan_settings
     SET last_number = $1, updated_at = NOW()
     WHERE company_id = $2`,
    [nextSeq, companyId]
  );

  return { challanNo: formatChallanNo(nextSeq), seq: nextSeq };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: peekNextChallanNumber
// Read-only — does NOT increment. Used by GET /api/v1/challan/next-number
// ─────────────────────────────────────────────────────────────────────────────

export async function peekNextChallanNumber(companyId) {
  // Single optimized query — settings + count together
  const result = await pool.query(
    `SELECT
       cs.last_number,
       (SELECT COUNT(*) FROM ${DB_SCHEMA}.challans WHERE company_id = $1) AS challan_count
     FROM ${DB_SCHEMA}.challan_settings cs
     WHERE cs.company_id = $1`,
    [companyId]
  );

  // No settings yet OR challans cleared → return 0001
  if (!result.rows.length || parseInt(result.rows[0].challan_count, 10) === 0) {
    return { next_challan_number: formatChallanNo(1), current_seq: 0 };
  }

  const nextSeq = Number(result.rows[0].last_number) + 1;
  return {
    next_challan_number: formatChallanNo(nextSeq),
    current_seq:         Number(result.rows[0].last_number),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createChallan
// ─────────────────────────────────────────────────────────────────────────────

export async function createChallan(data) {
  const {
    company_id,
    challan_date,
    customer_name    = null,
    customer_gstin   = null,
    customer_address = null,
    narration        = null,
    supply_type      = "intrastate",
    items            = [],
  } = data;

  let company_name = data.company_name || null;

  if (!company_id)   throw new Error("company_id is required");
  if (!challan_date) throw new Error("challan_date is required");
  if (!items.length) throw new Error("At least one item is required");

  for (const [i, item] of items.entries()) {
    if (!item.item_name) throw new Error(`Item at index ${i} is missing item_name`);
  }

  const computedItems = items.map((it) => computeItem(it, supply_type));
  const totals        = computeTotals(computedItems);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If company_name not sent, fetch from companies table
    if (!company_name) {
      const compRes = await client.query(
        `SELECT name FROM ${DB_SCHEMA}.companies WHERE id = $1`,
        [company_id]
      );
      if (compRes.rows.length) company_name = compRes.rows[0].name;
    }

    // Atomically claim next number (0001, 0002, ...)
    const { challanNo, seq } = await allocateNextChallanNumber(client, company_id);

    // Insert challan header
    const challanRes = await client.query(
      `INSERT INTO ${DB_SCHEMA}.challans (
        company_id, company_name, challan_number, challan_seq,
        challan_date, customer_name, customer_gstin, customer_address,
        sub_total, total_cgst, total_sgst, total_igst, total_tax, grand_total,
        narration, status
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,
        $15,'DRAFT'
      ) RETURNING *`,
      [
        company_id, company_name, challanNo, seq,
        challan_date, customer_name, customer_gstin, customer_address,
        totals.sub_total, totals.total_cgst, totals.total_sgst,
        totals.total_igst, totals.total_tax, totals.grand_total,
        narration,
      ]
    );

    const challan   = challanRes.rows[0];
    const challanId = challan.id;

    // Insert line items
    const insertedItems = [];
    for (const [idx, it] of computedItems.entries()) {
      const itemRes = await client.query(
        `INSERT INTO ${DB_SCHEMA}.challan_items (
          challan_id, item_name, godown_name, hsn_code,
          qty, rate, gst_rate, discount_percent,
          taxable_amount, cgst_amount, sgst_amount, igst_amount,
          line_total, sort_order
        ) VALUES (
          $1,$2,$3,$4,
          $5,$6,$7,$8,
          $9,$10,$11,$12,
          $13,$14
        ) RETURNING *`,
        [
          challanId, it.item_name, it.godown_name, it.hsn_code,
          it.qty, it.rate, it.gst_rate, it.discount_percent,
          it.taxable_amount, it.cgst_amount, it.sgst_amount, it.igst_amount,
          it.line_total, idx,
        ]
      );
      insertedItems.push(itemRes.rows[0]);
    }

    await client.query("COMMIT");
    return { ...challan, items: insertedItems };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getAllChallans
//
// UPDATED: now selects id, narration, status, and grand_total in addition
// to the original challan_number / challan_date / customer_name fields.
// These were being computed and stored on create, but were silently
// dropped from this response. Every field is included explicitly — even
// when null — so the frontend can always find the key on the row instead
// of it being missing.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllChallans(companyId, filters = {}) {
  const conditions = ["c.company_id = $1"];
  const values     = [companyId];
  let   idx        = 2;

  if (filters.status) {
    conditions.push(`c.status = $${idx++}`);
    values.push(filters.status.toUpperCase());
  }
  if (filters.from_date) {
    conditions.push(`c.challan_date >= $${idx++}`);
    values.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`c.challan_date <= $${idx++}`);
    values.push(filters.to_date);
  }
  if (filters.customer_name) {
    conditions.push(`c.customer_name ILIKE $${idx++}`);
    values.push(`%${filters.customer_name}%`);
  }

  // Fetch matching challans first
  const challanRes = await pool.query(
    `SELECT
       c.id,
       c.challan_number,
       c.challan_date,
       c.customer_name,
       c.narration,
       c.status,
       c.grand_total
     FROM ${DB_SCHEMA}.challans c
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.challan_seq DESC`,
    values
  );

  if (!challanRes.rows.length) return [];

  const challanNumbers = challanRes.rows.map(r => r.challan_number);

  const itemsRes = await pool.query(
    `SELECT
       c.challan_number,
       ci.item_name,
       ci.godown_name,
       ci.hsn_code,
       ci.qty,
       ci.rate,
       ci.gst_rate,
       ci.discount_percent,
       ci.line_total
     FROM ${DB_SCHEMA}.challan_items ci
     JOIN ${DB_SCHEMA}.challans c ON c.id = ci.challan_id
     WHERE c.challan_number = ANY($1)
       AND c.company_id = $2
     ORDER BY c.challan_seq DESC, ci.sort_order ASC`,
    [challanNumbers, companyId]
  );

  const itemsMap = {};
  for (const item of itemsRes.rows) {
    if (!itemsMap[item.challan_number]) itemsMap[item.challan_number] = [];
    const { challan_number, ...rest } = item;
    itemsMap[challan_number].push(rest);
  }

  return challanRes.rows.map(c => ({
    id:             c.id,
    challan_number: c.challan_number,
    challan_date:   c.challan_date,
    customer_name:  c.customer_name,
    narration:      c.narration,
    status:         c.status,
    grand_total:    c.grand_total,
    items:          itemsMap[c.challan_number] || [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getChallanTransactions
//
// Returns ONLY challans, using plain challan field names — no voucher-shape
// remapping, no merging with app_test.vouchers. Every field defined on the
// challan (including line items) is included explicitly; if a value is
// missing in the DB it comes back as null rather than being left out of
// the object.
// ─────────────────────────────────────────────────────────────────────────────

export async function getChallanTransactions(companyId, filters = {}) {
  const conditions = ["c.company_id = $1"];
  const values     = [companyId];
  let   idx        = 2;

  if (filters.from_date) {
    conditions.push(`DATE(c.challan_date) >= $${idx++}`);
    values.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`DATE(c.challan_date) <= $${idx++}`);
    values.push(filters.to_date);
  }
  if (filters.party) {
    conditions.push(`LOWER(c.customer_name) LIKE LOWER($${idx++})`);
    values.push(`%${filters.party}%`);
  }
  if (filters.status) {
    conditions.push(`c.status = $${idx++}`);
    values.push(filters.status.toUpperCase());
  }

  const challanRes = await pool.query(
    `SELECT
       c.id,
       c.company_id,
       c.company_name,
       c.challan_number,
       c.challan_date,
       c.customer_name,
       c.customer_gstin,
       c.customer_address,
       c.narration,
       c.status,
       c.sub_total,
       c.total_cgst,
       c.total_sgst,
       c.total_igst,
       c.total_tax,
       c.grand_total,
       c.created_at,
       c.updated_at
     FROM ${DB_SCHEMA}.challans c
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.challan_date DESC, c.id DESC`,
    values
  );

  if (!challanRes.rows.length) return [];

  const challanIds = challanRes.rows.map((r) => r.id);

  const itemsRes = await pool.query(
    `SELECT *
     FROM ${DB_SCHEMA}.challan_items
     WHERE challan_id = ANY($1)
     ORDER BY challan_id, sort_order ASC, id ASC`,
    [challanIds]
  );

  const itemsMap = {};
  for (const item of itemsRes.rows) {
    if (!itemsMap[item.challan_id]) itemsMap[item.challan_id] = [];
    itemsMap[item.challan_id].push(item);
  }

  return challanRes.rows.map((c) => ({
    id:                c.id,
    company_id:        c.company_id,
    company_name:      c.company_name,
    challan_number:    c.challan_number,
    challan_date:      c.challan_date,
    customer_name:     c.customer_name,
    customer_gstin:    c.customer_gstin,
    customer_address:  c.customer_address,
    narration:         c.narration,
    status:            c.status,
    sub_total:         c.sub_total,
    total_cgst:        c.total_cgst,
    total_sgst:        c.total_sgst,
    total_igst:        c.total_igst,
    total_tax:         c.total_tax,
    grand_total:       c.grand_total,
    created_at:        c.created_at,
    updated_at:        c.updated_at,
    items:             itemsMap[c.id] || [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getChallanById
// ─────────────────────────────────────────────────────────────────────────────

export async function getChallanById(challanId, companyId) {
  const challanRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.challans WHERE id = $1 AND company_id = $2`,
    [challanId, companyId]
  );
  if (!challanRes.rows.length) return null;

  const itemsRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.challan_items
     WHERE challan_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [challanId]
  );

  return { ...challanRes.rows[0], items: itemsRes.rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: updateChallanStatus
// ─────────────────────────────────────────────────────────────────────────────

export async function updateChallanStatus(challanId, companyId, status) {
  const allowed = ["DRAFT", "CONFIRMED", "CANCELLED"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status. Allowed: ${allowed.join(", ")}`);
  }

  const result = await pool.query(
    `UPDATE ${DB_SCHEMA}.challans
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [status, challanId, companyId]
  );

  return result.rows[0] || null;
}