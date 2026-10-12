// src/services/gstr3b/gstr3b.service.js
//
// GSTR-3B step, part 1 ("Prepare"): work out the return from the books —
// outward supplies via the GSTR-1 builder, ITC from the period's accepted
// IMS invoices, nil/exempt inward from purchases — plus the tax payment,
// and store it in gst_gstr3b_runs. No GSTN call happens here.

import pool from "../../db/index.js";
import { DB_SCHEMA } from "../../config/db.js";
import { resolvePeriod, loadInputs } from "../gstr1/gstr1Prepare.service.js";
import { buildGstr1 } from "../gstr1/gstr1Builder.js";
import { getImsRun, finalAction, loadPurchases } from "../ims/ims.service.js";
import { normalizePurchase } from "../ims/imsMatcher.js";
import { buildGstr3b } from "./gstr3bBuilder.js";

function httpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function prepareGstr3b({ companyId, gstin, retPeriod, frequency, createdBy }) {
  const period = resolvePeriod({ retPeriod, frequency });
  if (!period) throw httpError(400, "Invalid return period");

  const { rows: credRows } = await pool.query(
    `SELECT hsn_min_digits FROM ${DB_SCHEMA}.gst_credentials WHERE company_id = $1 AND gstin = $2`,
    [companyId, gstin]
  );
  if (!credRows[0]) throw httpError(400, "GST credentials not found for this company/gstin — complete GST login first");

  const existing = await getGstr3bRun({ companyId, gstin, period: period.period });
  // Rebuilding is fine until the liability is offset (saving again then
  // replaces what's on the portal).
  if (existing && !["PREPARED", "SAVE_FAILED", "SAVED"].includes(existing.stage)) {
    throw httpError(409, `GSTR-3B for ${period.period} is at stage ${existing.stage} — it can't be rebuilt now`);
  }

  // Outward supplies: the same build GSTR-1 uses, so 3.1 agrees with GSTR-1.
  const inputs = await loadInputs(companyId, period);
  const g1 = buildGstr1({ supplierGstin: gstin, period, ...inputs, options: { hsnMinDigits: credRows[0].hsn_min_digits || 6 } });
  const included = new Set(g1.invoices.map((i) => i.voucherId));
  const outwardBlocked = new Set(
    g1.issues.filter((i) => i.severity === "error" && i.voucherId && !included.has(i.voucherId)).map((i) => i.voucherId)
  ).size;

  // ITC: the period's IMS invoices with the action that will be sent.
  const ims = await getImsRun({ companyId, gstin, period: period.period });
  const imsRows = ims ? ims.rows.map((r) => ({ ...r, action: finalAction(r, ims.decisions) })) : null;

  // Table 5: purchases in the period that carry no tax.
  const supplierState = gstin.slice(0, 2);
  const inwardExempt = (await loadPurchases(companyId, period.fromDate, period.toDate))
    .map(normalizePurchase)
    .filter((p) => p && p.kind === "PURCHASE" && p.taxable > 0 && p.igst + p.cgst + p.sgst + p.cess === 0)
    .map((p) => ({ inter: !!p.gstin && p.gstin.slice(0, 2) !== supplierState, value: p.taxable }));

  // Once GSTR-2B is regenerated and verified, its figures are the ITC (2B is
  // what GSTN checks 3B against); until then, the invoices accepted in IMS.
  const itcFrom2b = ims?.stage === "VERIFIED" ? ims.gstr2b?.verification : null;
  const result = buildGstr3b({ gstin, retPeriod: period.retPeriod, outward: g1.invoices, outwardBlocked, imsRows, inwardExempt, itcFrom2b, imsStage: ims?.stage || null });

  await pool.query(
    `
    INSERT INTO ${DB_SCHEMA}.gst_gstr3b_runs
      (company_id, gstin, return_period, ret_period, stage, payload, liability, itc, payment, issues, stats, prepared_at, created_by, updated_at)
    VALUES ($1,$2,$3,$4,'PREPARED',$5,$6,$7,$8,$9,$10,now(),$11,now())
    ON CONFLICT (company_id, gstin, return_period) DO UPDATE SET
      stage = 'PREPARED', portal_check = NULL, offset_plan = NULL, payload = EXCLUDED.payload, liability = EXCLUDED.liability, itc = EXCLUDED.itc,
      payment = EXCLUDED.payment, issues = EXCLUDED.issues, stats = EXCLUDED.stats, prepared_at = now(), updated_at = now()
    `,
    [companyId, gstin, period.period, period.retPeriod, JSON.stringify(result.payload), JSON.stringify(result.liability),
      JSON.stringify(result.itc), JSON.stringify(result.payment), JSON.stringify(result.issues), JSON.stringify(result.stats), createdBy || null]
  );
  return getGstr3bRun({ companyId, gstin, period: period.period });
}

export async function getGstr3bRun({ companyId, gstin, period }) {
  const { rows } = await pool.query(
    `
    SELECT id, gstin, return_period, ret_period, stage, payload, liability, itc, payment, issues, stats, prepared_at,
           portal_check, save_ref_id, save_status, portal_summary, ledger_balance, offset_plan, offset_status,
           final_summary, file_status, arn, filed_at
    FROM ${DB_SCHEMA}.gst_gstr3b_runs WHERE company_id = $1 AND gstin = $2 AND return_period = $3
    `,
    [companyId, gstin, period]
  );
  return rows[0] || null;
}
