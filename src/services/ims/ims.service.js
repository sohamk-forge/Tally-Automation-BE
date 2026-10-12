// src/services/ims/ims.service.js
//
// IMS step, part 1: fetch the invoices waiting in IMS from the portal,
// match them against the company's purchase vouchers, and keep the
// proposed actions plus the user's overrides per return period in
// gst_ims_runs. Saving actions to the portal / generating 2B come next.

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import * as whitebooks from "../whitebooks.service.js";
import { getActiveGstSession } from "../gstAuth.service.js";
import { resolvePeriod } from "../gstr1/gstr1Prepare.service.js";
import { normalizePurchase, matchIms } from "./imsMatcher.js";
import { assertImsOpen } from "./imsPortal.service.js";

// IMS sections fetched. Credit/debit-note section codes are as GSTN names
// them; a section the portal rejects is reported as a warning, not a failure.
export const IMS_SECTIONS = ["B2B", "B2BA", "B2BDN", "B2BCN"];
const ACTIONS = new Set(["A", "R", "P"]);

const yyyymm = (mmyyyy) => `${String(mmyyyy).slice(2)}${String(mmyyyy).slice(0, 2)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function httpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Fields of an IMS record that identify it to GSTN on save (per GSTN's IMS
// API). Everything else the GET returns (filing status, flags) is dropped.
const IMS_SAVE_FIELDS = [
  "stin", "inv_typ", "srcform", "rtnprd", "inum", "idt", "nt_num", "nt_dt", "ntty",
  "oinum", "oidt", "ont_num", "ont_dt", "val", "pos", "hash",
];
const portalRecord = (inv) => Object.fromEntries(IMS_SAVE_FIELDS.filter((k) => inv[k] !== undefined).map((k) => [k, inv[k]]));

/** The action that will be sent: the user's override, else the proposal. */
export const finalAction = (row, decisions) => decisions?.[row.key] ?? row.proposed;

function computeStats(rows, decisions, onlyInBooks) {
  const inPeriod = rows.filter((r) => r.inPeriod);
  const count = (pred) => inPeriod.filter(pred).length;
  const itc = (pred) => r2(inPeriod.filter(pred).reduce((a, r) => a + r.itc, 0));
  const act = (r) => finalAction(r, decisions);
  return {
    total: rows.length,
    inPeriod: inPeriod.length,
    laterPeriods: rows.length - inPeriod.length,
    matched: count((r) => r.status === "MATCHED"),
    mismatch: count((r) => r.status === "MISMATCH"),
    notInBooks: count((r) => r.status === "NOT_IN_BOOKS"),
    accept: count((r) => act(r) === "A"),
    pending: count((r) => act(r) === "P"),
    reject: count((r) => act(r) === "R"),
    undecided: count((r) => !act(r)),
    itcAccepted: itc((r) => act(r) === "A"),
    itcPending: itc((r) => act(r) === "P"),
    itcRejected: itc((r) => act(r) === "R"),
    onlyInBooks: onlyInBooks.length,
  };
}

export async function loadPurchases(companyId, fromDate, toDate) {
  const { rows } = await pool.query(
    `
    SELECT v.id, v.voucher_type, v.voucher_number, v.party_ledger_name, v.narration, v.ledger_entries,
           to_char(v.voucher_date, 'DD-MM-YYYY') AS idt, to_char(v.voucher_date, 'YYYY-MM-DD') AS date,
           COALESCE(NULLIF(v.party_gstin, ''), l.gst_number) AS gstin,
           v.supplier_invoice_no, to_char(v.supplier_invoice_date, 'DD-MM-YYYY') AS supplier_invoice_idt,
           v.is_cancelled, v.is_optional
    FROM ${DB_SCHEMA}.vouchers v
    LEFT JOIN LATERAL (
      SELECT gst_number FROM ${DB_SCHEMA}.all_ledger_details a
      WHERE a.company_id = v.company_id AND a.deleted_at IS NULL
        AND lower(regexp_replace(a.ledger_name, '\\s+', ' ', 'g')) = lower(regexp_replace(v.party_ledger_name, '\\s+', ' ', 'g'))
      LIMIT 1
    ) l ON true
    WHERE v.company_id = $1 AND v.deleted_at IS NULL
      AND v.voucher_date BETWEEN $2 AND $3
      AND v.voucher_type ~* 'purchase|debit\\s*note' AND v.voucher_type !~* 'order'
    `,
    [companyId, fromDate, toDate]
  );
  return rows;
}

/**
 * Fetch IMS from the portal, match, and store. Keeps earlier user
 * decisions for invoices that are still in IMS.
 */
export async function refreshIms({ companyId, gstin, retPeriod, frequency, ipAddress, createdBy }) {
  const period = resolvePeriod({ retPeriod, frequency });
  if (!period) throw httpError(400, "Invalid return period");

  // Re-fetching is allowed (IMS changes as suppliers file) except while the
  // portal is processing a request; the stage drops back to FETCHED so save
  // / 2B have to be redone.
  const existing = await getImsRun({ companyId, gstin, period: period.period });
  if (existing && ["SAVE_PENDING", "GEN2B_PENDING"].includes(existing.stage)) {
    throw httpError(409, "Wait for the IMS save / 2B generation in progress to finish before fetching again");
  }
  await assertImsOpen({ companyId, gstin, period: period.period });

  const session = await getActiveGstSession({ companyId, gstin });
  const config = whitebooks.getWhiteBooksConfig();
  const warnings = [];
  const imsRows = [];
  for (const section of IMS_SECTIONS) {
    try {
      const list = await whitebooks.getImsInvoices({
        gstin, section, txn: session.txn, gstUsername: session.gstUsername,
        ipAddress: config.ipAddress || ipAddress, ...config,
      });
      for (const inv of list) {
        imsRows.push({
          ...inv,
          section,
          inum: inv.inum ?? inv.nt_num,
          idt: inv.idt ?? inv.nt_dt,
          src: portalRecord(inv), // echoed back on save with only the action changed
        });
      }
    } catch (err) {
      if (err.code === 401) throw err;
      warnings.push(`Couldn't read the ${section} section from IMS: ${err.message}`);
    }
  }
  if (warnings.length === IMS_SECTIONS.length) {
    throw httpError(502, `Couldn't read IMS from the GST portal. ${warnings[0]}`);
  }

  // Purchases from well before the earliest IMS invoice up to the period end.
  const earliest = imsRows.map((i) => i.idt).filter(Boolean).map((d) => d.split("-").reverse().join("-")).sort()[0] || period.fromDate;
  const from = new Date(earliest < period.fromDate ? earliest : period.fromDate);
  from.setDate(from.getDate() - 60);
  const purchaseRows = await loadPurchases(companyId, from.toISOString().slice(0, 10), period.toDate);
  const purchases = purchaseRows.map(normalizePurchase).filter(Boolean);

  const { rows, usedVoucherIds } = matchIms(imsRows, purchases);
  const periodKey = yyyymm(period.retPeriod);
  for (const r of rows) r.inPeriod = !r.rtnprd || yyyymm(r.rtnprd) <= periodKey;

  // Booked in this period with a GSTIN, but no IMS invoice for it (vouchers
  // shown against a mismatched IMS invoice are left out — they're not missing).
  const byId = new Map(purchaseRows.map((p) => [p.id, p]));
  const linked = new Set([...usedVoucherIds, ...rows.filter((r) => r.voucher).map((r) => r.voucher.id)]);
  const onlyInBooks = purchases
    .filter((p) => p.gstin && !linked.has(p.voucherId))
    .filter((p) => { const d = byId.get(p.voucherId)?.date; return d >= period.fromDate && d <= period.toDate; })
    .map((p) => ({ voucherId: p.voucherId, voucherNumber: p.voucherNumber, voucherType: p.voucherType, date: p.date, partyName: p.partyName, gstin: p.gstin, taxable: p.taxable, tax: r2(p.igst + p.cgst + p.sgst + p.cess) }));

  // Carry over decisions for invoices still present and still allowed.
  const keep = {};
  for (const r of rows) {
    const d = existing?.decisions?.[r.key];
    if (d && !(d === "P" && r.pendingBlocked)) keep[r.key] = d;
  }
  const stats = computeStats(rows, keep, onlyInBooks);

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_ims_runs
      (company_id, gstin, return_period, ret_period, from_date, to_date, stage, rows, decisions, only_in_books, warnings, stats, fetched_at, created_by, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,'FETCHED',$7,$8,$9,$10,$11,now(),$12,now())
    ON CONFLICT (company_id, gstin, return_period) DO UPDATE SET
      stage = 'FETCHED', rows = EXCLUDED.rows, decisions = EXCLUDED.decisions, only_in_books = EXCLUDED.only_in_books,
      warnings = EXCLUDED.warnings, stats = EXCLUDED.stats, fetched_at = now(), updated_at = now()
    `,
    [companyId, gstin, period.period, period.retPeriod, period.fromDate, period.toDate,
      JSON.stringify(rows), JSON.stringify(keep), JSON.stringify(onlyInBooks), JSON.stringify(warnings), JSON.stringify(stats), createdBy || null]
  );
  return getImsRun({ companyId, gstin, period: period.period });
}

export async function getImsRun({ companyId, gstin, period }) {
  const { rows } = await pool.query(
    `
    SELECT id, gstin, return_period, ret_period, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date,
           stage, rows, decisions, only_in_books, warnings, stats, fetched_at, save_ref_id, save_status, gen2b_ref_id, gen2b_status, gstr2b, verified_at
    FROM ${DB_SCHEMA}.gst_ims_runs WHERE company_id = $1 AND gstin = $2 AND return_period = $3
    `,
    [companyId, gstin, period]
  );
  return rows[0] || null;
}

/**
 * Record the user's actions. decisions: [{ key, action: "A"|"R"|"P"|null }]
 * (null clears the override and falls back to the proposal).
 */
export async function setImsDecisions({ companyId, gstin, period, decisions }) {
  const run = await getImsRun({ companyId, gstin, period });
  if (!run) throw httpError(404, "Fetch IMS invoices for this period first");
  if (["SAVE_PENDING", "GEN2B_PENDING"].includes(run.stage)) throw httpError(409, "Wait for the IMS save / 2B generation in progress to finish");
  await assertImsOpen({ companyId, gstin, period });
  const rowByKey = new Map(run.rows.map((r) => [r.key, r]));
  const merged = { ...(run.decisions || {}) };
  for (const d of decisions || []) {
    const row = rowByKey.get(d.key);
    if (!row) throw httpError(400, `Unknown IMS invoice ${d.key}`);
    if (d.action == null) { delete merged[d.key]; continue; }
    if (!ACTIONS.has(d.action)) throw httpError(400, `Action must be A, R or P`);
    if (d.action === "P" && row.pendingBlocked) throw httpError(400, `GSTN doesn't allow 'pending' for invoice ${row.inum} — accept or reject it`);
    merged[d.key] = d.action;
  }
  const stats = computeStats(run.rows, merged, run.only_in_books || []);
  // Any change after a save means the portal no longer reflects it.
  await pool.query(
    `UPDATE ${DB_SCHEMA}.gst_ims_runs
     SET decisions = $4, stats = $5, stage = 'FETCHED', updated_at = now()
     WHERE company_id = $1 AND gstin = $2 AND return_period = $3`,
    [companyId, gstin, period, JSON.stringify(merged), JSON.stringify(stats)]
  );
  return getImsRun({ companyId, gstin, period });
}
