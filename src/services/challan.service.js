/**
 * src/services/challan.service.js
 *
 * Business logic for challan creation, numbering, and retrieval.
 *
 * Challan number format:
 *   <prefix><padded_seq>
 *   e.g. prefix = "25-26/"  →  "25-26/0001", "25-26/0002" ...
 *
 * ONE-API DESIGN:
 *   createChallan() now handles BOTH prefix setup and challan creation.
 *   - First ever call for a company: pass "prefix" in the body → it gets
 *     saved automatically, and the first challan becomes <prefix>0001.
 *   - Every call after that: "prefix" (if sent) is IGNORED — the prefix
 *     already stored for that company is always used, and the number just
 *     keeps incrementing (0002, 0003, ...).
 *   - If no prefix exists yet AND none is sent → clear error is thrown.
 *
 * The counter increment (and the first-time prefix insert) happen ATOMICALLY
 * inside a DB transaction with a row lock, so concurrent requests never
 * collide or get duplicate numbers.
 */

import pool from "../db/index.js";

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

/**
 * Compute line-level tax amounts and totals from raw item input.
 *
 * @param {object} item
 * @param {string} supplyType  "interstate" | "intrastate"  (default intrastate)
 * @returns {object}  enriched item with computed amounts
 */
function computeItem(item, supplyType = "intrastate") {
  const qty        = toNum(item.qty);
  const rate       = toNum(item.rate);
  const discPct    = toNum(item.discount_percent);
  const gstRateStr = String(item.gst_rate || "0%").replace("%", "");
  const gstRate    = toNum(gstRateStr);

  const grossAmt   = round2(qty * rate);
  const discAmt    = round2(grossAmt * discPct / 100);
  const taxableAmt = round2(grossAmt - discAmt);

  const totalTax = round2(taxableAmt * gstRate / 100);

  let cgst = 0, sgst = 0, igst = 0;
  if (supplyType === "interstate") {
    igst = totalTax;
  } else {
    cgst = round2(totalTax / 2);
    sgst = round2(totalTax / 2);
  }

  const lineTotal = round2(taxableAmt + totalTax);

  return {
    item_name:        String(item.item_name || "").trim(),
    godown_name:      String(item.godown_name || "").trim() || null,
    hsn_code:         String(item.hsn_code || "").trim()   || null,
    qty,
    rate,
    gst_rate:         `${gstRate}%`,
    discount_percent: discPct,
    taxable_amount:   taxableAmt,
    cgst_amount:      cgst,
    sgst_amount:      sgst,
    igst_amount:      igst,
    line_total:       lineTotal,
    sort_order:       toNum(item.sort_order, 0),
  };
}

/**
 * Sum all items into header-level totals.
 */
function computeTotals(computedItems) {
  let subTotal  = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

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
// PUBLIC: setPrefix  (kept for optional manual/admin use — NOT required
// anymore for normal flow, since createChallan() handles it automatically)
// ─────────────────────────────────────────────────────────────────────────────

export async function setPrefix(companyId, prefix, padLength = 4, startFrom = 0) {
  const trimmed = String(prefix).trim();
  if (!trimmed) throw new Error("prefix cannot be empty");

  const result = await pool.query(
    `INSERT INTO app_test.challan_settings
       (company_id, prefix, pad_length, last_number, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id) DO UPDATE
       SET prefix      = EXCLUDED.prefix,
           pad_length  = EXCLUDED.pad_length,
           last_number = EXCLUDED.last_number,
           updated_at  = NOW()
     RETURNING *`,
    [companyId, trimmed, padLength, startFrom]
  );

  return result.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getPrefix
// ─────────────────────────────────────────────────────────────────────────────

export async function getPrefix(companyId) {
  const result = await pool.query(
    `SELECT * FROM app_test.challan_settings WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: resolveChallanNumber  (runs inside transaction)
//
// - Locks (or creates, if first time) the settings row for this company.
// - Increments last_number atomically.
// - Returns the full challan number string + whether prefix was just created.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveChallanNumber(client, companyId, prefixInput, padLengthInput) {
  // Try to lock existing settings row
  let settingsRes = await client.query(
    `SELECT * FROM app_test.challan_settings
     WHERE company_id = $1
     FOR UPDATE`,
    [companyId]
  );

  let prefixJustCreated = false;

  if (!settingsRes.rows.length) {
    // First time for this company — prefix MUST be supplied
    const trimmed = String(prefixInput || "").trim();
    if (!trimmed) {
      throw new Error(
        `No challan prefix configured for company ${companyId}. ` +
        `Send "prefix" (e.g. "25-26/") in the request body once — it will be saved automatically.`
      );
    }

    const padLength = Number(padLengthInput) > 0 ? Number(padLengthInput) : 4;

    settingsRes = await client.query(
      `INSERT INTO app_test.challan_settings
         (company_id, prefix, pad_length, last_number, updated_at)
       VALUES ($1, $2, $3, 0, NOW())
       RETURNING *`,
      [companyId, trimmed, padLength]
    );

    prefixJustCreated = true;
  }

  // NOTE: prefix is now fixed for this company — any "prefix" sent on
  // later requests is intentionally ignored, per requirement that the
  // format stays static once set.

  const settings  = settingsRes.rows[0];
  const nextNum   = Number(settings.last_number) + 1;
  const padded    = String(nextNum).padStart(settings.pad_length, "0");
  const challanNo = `${settings.prefix}${padded}`;

  await client.query(
    `UPDATE app_test.challan_settings
     SET last_number = $1, updated_at = NOW()
     WHERE company_id = $2`,
    [nextNum, companyId]
  );

  return { challanNo, seq: nextNum, prefixJustCreated, prefix: settings.prefix };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createChallan
//
// ONE API — does everything:
//   1. If this is the company's first challan ever, saves "prefix" from
//      the request body automatically (padLength optional, default 4).
//   2. Auto-generates the next challan number off that prefix.
//   3. Computes item-level + header-level GST totals.
//   4. Inserts challan header + line items in a single transaction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} data
 * @param {number}   data.company_id
 * @param {string}   data.company_name
 * @param {string}   [data.prefix]           only used the FIRST time for a company
 * @param {number}   [data.pad_length]        only used the FIRST time, default 4
 * @param {string}   data.challan_date       ISO date string "YYYY-MM-DD"
 * @param {string}   data.customer_name
 * @param {string}   [data.customer_gstin]
 * @param {string}   [data.customer_address]
 * @param {string}   [data.narration]
 * @param {string}   [data.supply_type]      "intrastate" | "interstate"
 * @param {object[]} data.items              array of line items
 * @returns {object}  created challan with items
 */
export async function createChallan(data) {
  const {
    company_id,
    company_name,
    prefix            = null,
    pad_length        = 4,
    challan_date,
    customer_name,
    customer_gstin    = null,
    customer_address  = null,
    narration         = null,
    supply_type       = "intrastate",
    items             = [],
  } = data;

  if (!company_id)   throw new Error("company_id is required");
  if (!challan_date) throw new Error("challan_date is required");
  if (!items.length) throw new Error("At least one line item is required");

  // Validate items
  for (const [i, item] of items.entries()) {
    if (!item.item_name) throw new Error(`Item at index ${i} is missing item_name`);
  }

  // Compute item-level amounts
  const computedItems = items.map((it) => computeItem(it, supply_type));
  const totals        = computeTotals(computedItems);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Resolve (and, if needed, auto-create) prefix + get next challan number
    const { challanNo, seq, prefixJustCreated, prefix: usedPrefix } =
      await resolveChallanNumber(client, company_id, prefix, pad_length);

    // 2. Insert challan header
    const challanRes = await client.query(
      `INSERT INTO app_test.challans (
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

    // 3. Insert line items
    const insertedItems = [];
    for (const [idx, it] of computedItems.entries()) {
      const itemRes = await client.query(
        `INSERT INTO app_test.challan_items (
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

    return {
      ...challan,
      items:              insertedItems,
      prefix_used:        usedPrefix,
      prefix_just_created: prefixJustCreated,
    };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getAllChallans
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

  const result = await pool.query(
    `SELECT
       c.id, c.company_id, c.company_name,
       c.challan_number, c.challan_seq, c.challan_date,
       c.customer_name, c.customer_gstin, c.customer_address,
       c.sub_total, c.total_cgst, c.total_sgst, c.total_igst,
       c.total_tax, c.grand_total,
       c.narration, c.status,
       c.created_at, c.updated_at,
       COUNT(ci.id) AS item_count
     FROM app_test.challans c
     LEFT JOIN app_test.challan_items ci ON ci.challan_id = c.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY c.id
     ORDER BY c.challan_seq DESC`,
    values
  );

  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getChallanById
// ─────────────────────────────────────────────────────────────────────────────

export async function getChallanById(challanId, companyId) {
  const challanRes = await pool.query(
    `SELECT * FROM app_test.challans
     WHERE id = $1 AND company_id = $2`,
    [challanId, companyId]
  );

  if (!challanRes.rows.length) return null;

  const itemsRes = await pool.query(
    `SELECT * FROM app_test.challan_items
     WHERE challan_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [challanId]
  );

  return {
    ...challanRes.rows[0],
    items: itemsRes.rows,
  };
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
    `UPDATE app_test.challans
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [status, challanId, companyId]
  );

  return result.rows[0] || null;
}