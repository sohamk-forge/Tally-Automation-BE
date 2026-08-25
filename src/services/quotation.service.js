/**
 * src/services/quotation.service.js
 *
 * Quotation numbers: 0001, 0002, 0003 ...
 * - No prefix, starts from 0001 automatically, resets to 0001 if DB cleared
 * - User never inputs the number
 *
 * Versioning:
 * - Any quotation (root or an existing version) can be "revised" into a new
 *   version without losing the original.
 * - root_quotation_id points at the FIRST quotation in the family (a root
 *   row points at its own id).
 * - version_seq is 0 on the original, 1/2/3... on each new version.
 * - Display number for a version = "<root 0001>.<version 01>", e.g.
 *   0001.01, 0001.02 ... The root itself just displays as 0001.
 * - All versions share the root's quotation_seq, so the numbering sequence
 *   used by allocateNextQuotationNumber() only advances for brand-new
 *   quotations, never for revisions.
 *
 * No settings table needed — next number is derived from
 * MAX(quotation_seq) on the quotations table itself, guarded by a
 * Postgres transaction-scoped advisory lock (per company_id) so two
 * concurrent creates can't grab the same number. Versions use their own
 * lock keyed on the root quotation's id.
 *
 * GST handling: gst_enabled is read once per create from
 * app_test.company_details and applied to every line item.
 *
 * Company profile for PDFs: getQuotationById / getQuotationByRootAndVersion
 * pull a fresh company profile (name/address/email/gstin/state/gst_enabled)
 * from app_test.company_details, the same way challan.service.js#getChallanById
 * does, instead of relying only on the company_name snapshot stored on the
 * quotations row at creation time.
 */

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUOTATION_PAD_LENGTH = 4; // 0001, 0002, ...
const VERSION_PAD_LENGTH   = 2; // .01, .02, ...

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

// versionSeq = 0 -> just the base number (the root/original quotation)
// versionSeq > 0 -> base number + ".NN"
function formatVersionedNo(rootSeq, versionSeq) {
  const base = formatQuotationNo(rootSeq);
  if (!versionSeq) return base;
  return `${base}.${String(versionSeq).padStart(VERSION_PAD_LENGTH, "0")}`;
}

function computeItem(item, supplyType = "intrastate", gstEnabled = true) {
  const qty        = toNum(item.qty);
  const rate       = toNum(item.rate);
  const discPct    = toNum(item.discount_percent);

  const grossAmt   = round2(qty * rate);
  const discAmt    = round2(grossAmt * discPct / 100);
  const taxableAmt = round2(grossAmt - discAmt);

  const base = {
    item_name:        String(item.item_name || "").trim(),
    godown_name:      String(item.godown_name || "").trim() || null,
    bin:              String(item.bin || "").trim() || null,
    hsn_code:         String(item.hsn_code   || "").trim() || null,
    unit:             String(item.unit || "").trim() || null,
    qty,
    rate,
    discount_percent: discPct,
    taxable_amount:   taxableAmt,
    sort_order:       toNum(item.sort_order, 0),
  };

  if (!gstEnabled) {
    return {
      ...base,
      gst_rate:    "0%",
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      line_total:  taxableAmt,
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
    ...base,
    gst_rate:    `${gstRate}%`,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    line_total:  round2(taxableAmt + totalTax),
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

// Pulls the live company profile (name/address/email/gstin/state/gst_enabled)
// for a company, the same shape challan.service.js#getChallanById builds.
// Falls back gracefully if company_details has no row yet.
async function getCompanyDetails(companyId) {
  const res = await pool.query(
    `SELECT company_name, address, state, email, gstin, gst_enabled
     FROM ${DB_SCHEMA}.company_details
     WHERE company_id = $1`,
    [companyId]
  );
  return res.rows[0] || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: allocateNextQuotationNumber (brand-new family, runs inside txn)
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
// INTERNAL: allocateNextVersion (same family, runs inside txn)
// Locks on the root quotation's id so concurrent revisions of the SAME
// quotation serialize, while different quotation families stay independent.
// ─────────────────────────────────────────────────────────────────────────────

async function allocateNextVersion(client, rootId) {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [rootId]);

  const maxRes = await client.query(
    `SELECT COALESCE(MAX(version_seq), 0) AS max_version
     FROM ${DB_SCHEMA}.quotations
     WHERE root_quotation_id = $1`,
    [rootId]
  );

  return Number(maxRes.rows[0].max_version) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: getGstEnabled (runs inside transaction)
// ─────────────────────────────────────────────────────────────────────────────

async function getGstEnabled(client, companyId) {
  const res = await client.query(
    `SELECT gst_enabled FROM ${DB_SCHEMA}.company_details WHERE company_id = $1`,
    [companyId]
  );
  return res.rows[0]?.gst_enabled ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: insertItems
// ─────────────────────────────────────────────────────────────────────────────

async function insertItems(client, quotationId, computedItems) {
  const inserted = [];
  for (const [idx, it] of computedItems.entries()) {
    const res = await client.query(
      `INSERT INTO ${DB_SCHEMA}.quotation_items (
        quotation_id, item_name, godown_name, bin, hsn_code, unit,
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
        quotationId, it.item_name, it.godown_name, it.bin, it.hsn_code, it.unit,
        it.qty, it.rate, it.gst_rate, it.discount_percent,
        it.taxable_amount, it.cgst_amount, it.sgst_amount, it.igst_amount,
        it.line_total, idx,
      ]
    );
    inserted.push(res.rows[0]);
  }
  return inserted;
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
  const valid_until    = normalizeDate(data.valid_until);

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

   // Reserve the next id from the sequence up front so root_quotation_id
    // (NOT NULL, self-referencing) can be set in the same INSERT — no
    // follow-up UPDATE needed.
    const idRes = await client.query(
      `SELECT nextval(pg_get_serial_sequence('${DB_SCHEMA}.quotations', 'id')) AS id`
    );
    const quotationId = idRes.rows[0].id;

    const quotationRes = await client.query(
      `INSERT INTO ${DB_SCHEMA}.quotations (
        id, company_id, company_name, quotation_number, quotation_seq,
        version_seq, root_quotation_id,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        sub_total, total_cgst, total_sgst, total_igst, total_tax, grand_total,
        terms_conditions, status
      ) VALUES (
        $1,$2,$3,$4,$5,
        0,$1,
        $6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,
        $17,'DRAFT'
      ) RETURNING *`,
      [
        quotationId, company_id, company_name, quotationNo, seq,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        totals.sub_total, totals.total_cgst, totals.total_sgst,
        totals.total_igst, totals.total_tax, totals.grand_total,
        terms_conditions,
      ]
    );

    const quotation = quotationRes.rows[0];

    const insertedItems = await insertItems(client, quotationId, computedItems);

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
// PUBLIC: createQuotationVersion
//
// Creates a new revision of an existing quotation (starting from any
// version in the family). The new row keeps the SAME quotation_seq as the
// root (it's still "quotation #0001") but gets the next version_seq, so
// its display number becomes 0001.01, 0001.02, etc. The row being revised
// is left untouched and stays visible via getQuotationVersions().
//
// `data` accepts the same shape as createQuotation's body; any field left
// out falls back to the quotation being revised. If `items` is omitted
// entirely, the line items are cloned as-is.
// ─────────────────────────────────────────────────────────────────────────────

export async function createQuotationVersion(quotationId, companyId, data = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const srcRes = await client.query(
      `SELECT * FROM ${DB_SCHEMA}.quotations WHERE id = $1 AND company_id = $2`,
      [quotationId, companyId]
    );
    if (!srcRes.rows.length) throw new Error("Quotation not found");
    const source = srcRes.rows[0];
    const rootId = source.root_quotation_id || source.id;

    const rootRes = await client.query(
      `SELECT quotation_seq FROM ${DB_SCHEMA}.quotations WHERE id = $1`,
      [rootId]
    );
    const rootSeq = rootRes.rows[0].quotation_seq;

    const nextVersion = await allocateNextVersion(client, rootId);

    const customer_name    = data.customer_name    ?? source.customer_name;
    const customer_gstin   = data.customer_gstin   ?? source.customer_gstin;
    const customer_address = data.customer_address ?? source.customer_address;
    const terms_conditions = data.terms_conditions ?? source.terms_conditions;
    const supply_type      = data.supply_type || "intrastate";
    const quotation_date   = normalizeDate(data.quotation_date) || source.quotation_date;
    const valid_until      = normalizeDate(data.valid_until)    ?? source.valid_until;

    let items = data.items;
    if (!items || !items.length) {
      const srcItemsRes = await client.query(
        `SELECT * FROM ${DB_SCHEMA}.quotation_items WHERE quotation_id = $1 ORDER BY sort_order ASC, id ASC`,
        [quotationId]
      );
      items = srcItemsRes.rows;
    }
    if (!items.length) throw new Error("At least one item is required");
    for (const [i, item] of items.entries()) {
      if (!item.item_name) throw new Error(`Item at index ${i} is missing item_name`);
    }

    const gstEnabled    = await getGstEnabled(client, companyId);
    const computedItems = items.map((it) => computeItem(it, supply_type, gstEnabled));
    const totals        = computeTotals(computedItems);

    const quotationNo = formatVersionedNo(rootSeq, nextVersion);

    const insertRes = await client.query(
      `INSERT INTO ${DB_SCHEMA}.quotations (
        company_id, company_name, quotation_number, quotation_seq,
        root_quotation_id, version_seq, parent_quotation_id,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        sub_total, total_cgst, total_sgst, total_igst, total_tax, grand_total,
        terms_conditions, status
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,
        $19,'DRAFT'
      ) RETURNING *`,
      [
        companyId, source.company_name, quotationNo, rootSeq,
        rootId, nextVersion, quotationId,
        quotation_date, valid_until, customer_name, customer_gstin, customer_address,
        totals.sub_total, totals.total_cgst, totals.total_sgst,
        totals.total_igst, totals.total_tax, totals.grand_total,
        terms_conditions,
      ]
    );

    const newQuotation  = insertRes.rows[0];
    const insertedItems = await insertItems(client, newQuotation.id, computedItems);

    await client.query("COMMIT");
    return { ...newQuotation, items: insertedItems, gst_enabled: gstEnabled };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getQuotationVersions
// Full history for a quotation family, oldest (0001) first.
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuotationVersions(quotationId, companyId) {
  const srcRes = await pool.query(
    `SELECT root_quotation_id, id FROM ${DB_SCHEMA}.quotations WHERE id = $1 AND company_id = $2`,
    [quotationId, companyId]
  );
  if (!srcRes.rows.length) return null;
  const rootId = srcRes.rows[0].root_quotation_id || srcRes.rows[0].id;

  const res = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.quotations
     WHERE company_id = $1 AND root_quotation_id = $2
     ORDER BY version_seq ASC`,
    [companyId, rootId]
  );
  return res.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getAllQuotations
//
// By default returns only the LATEST version of each quotation family, so
// the list view (image 1) shows one row per quotation the way it does
// today. Pass filters.include_all_versions = true for an audit view that
// shows every revision.
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
  if (!filters.include_all_versions) {
    conditions.push(`q.version_seq = (
      SELECT MAX(v.version_seq) FROM ${DB_SCHEMA}.quotations v
      WHERE v.root_quotation_id = q.root_quotation_id
    )`);
  }

  const quotationRes = await pool.query(
    `SELECT
       q.*,
       COALESCE(items.item_count, 0)     AS item_count,
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
             'unit',              qi.unit,
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
     ORDER BY q.quotation_seq DESC, q.version_seq DESC`,
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

  // Pull the live company profile (name/address/email/gstin/state/gst_enabled)
  // for the PDF header, rather than relying only on the company_name
  // snapshot stored on the quotations row at creation time — same pattern
  // as challan.service.js#getChallanById.
  const companyDetails = await getCompanyDetails(companyId);
  const gstEnabled = companyDetails.gst_enabled ?? false;

  const quotation = quotationRes.rows[0];

  return {
    ...quotation,
    items: itemsRes.rows,
    gst_enabled: gstEnabled,
    // Fresh company profile for the PDF — falls back to the stored
    // quotations.company_name snapshot only if company_details has none.
    company_name:    companyDetails.company_name || quotation.company_name,
    company_address: companyDetails.address || null,
    company_state:   companyDetails.state || null,
    company_email:   companyDetails.email || null,
    company_gstin:   companyDetails.gstin || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getQuotationByRootAndVersion
// Convenience lookup for the PDF route: fetch a specific version of a
// quotation family by its root id + version number (0 = the original)
// instead of needing that version's own row id.
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuotationByRootAndVersion(rootId, versionSeq, companyId) {
  const res = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.quotations
     WHERE company_id = $1 AND root_quotation_id = $2 AND version_seq = $3`,
    [companyId, rootId, versionSeq]
  );
  if (!res.rows.length) return null;
  const quotation = res.rows[0];

  const itemsRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.quotation_items
     WHERE quotation_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [quotation.id]
  );

  // Same fresh company_details lookup as getQuotationById, so every PDF
  // entry point (by id, or by root+version) renders the current company
  // profile rather than a stale creation-time snapshot.
  const companyDetails = await getCompanyDetails(companyId);
  const gstEnabled = companyDetails.gst_enabled ?? false;

  return {
    ...quotation,
    items: itemsRes.rows,
    gst_enabled: gstEnabled,
    company_name:    companyDetails.company_name || quotation.company_name,
    company_address: companyDetails.address || null,
    company_state:   companyDetails.state || null,
    company_email:   companyDetails.email || null,
    company_gstin:   companyDetails.gstin || null,
  };
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