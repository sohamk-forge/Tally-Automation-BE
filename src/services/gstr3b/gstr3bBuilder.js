// src/services/gstr3b/gstr3bBuilder.js
//
// Pure GSTR-3B builder. Inputs are what the earlier steps already produce:
//   - outward supplies: the GSTR-1 builder's invoices for the period
//   - eligible ITC: IMS invoices of the period whose action is Accept
//   - nil / exempt inward supplies: purchase vouchers with no tax
// Output: the PUT /gstr3b/retsave body, the table-wise view for the screen,
// and the tax payment (how much ITC pays each tax head and the cash due).
//
// Severity: "error" blocks saving to GSTN, "warning" is shown but allowed.

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const HEADS = ["iamt", "camt", "samt", "csamt"];
const zero = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v]));

/**
 * Pay `liability` ({ iamt, camt, samt, csamt }) from `credit` (same shape)
 * per sections 49 / 49A / 49B and rule 88A:
 *   - IGST credit first against IGST, then CGST and SGST — and it must be
 *     used up before any CGST / SGST credit is touched;
 *   - CGST credit against CGST, then IGST; never SGST (and vice versa);
 *   - cess credit only against cess.
 * Where IGST credit can go to either CGST or SGST, it goes first where the
 * head's own credit falls short, so the least cash is needed.
 */
export function setOffLiability(liability, credit) {
  const L = { ...liability };
  const C = { ...credit };
  const used = { i_pdi: 0, i_pdc: 0, i_pds: 0, c_pdc: 0, c_pdi: 0, s_pds: 0, s_pdi: 0, cs_pdcs: 0 };
  const take = (from, to, key, cap = Infinity) => {
    const x = r2(Math.min(C[from], L[to], cap));
    if (x <= 0) return;
    C[from] = r2(C[from] - x);
    L[to] = r2(L[to] - x);
    used[key] = r2(used[key] + x);
  };

  // 1. IGST credit -> IGST
  take("iamt", "iamt", "i_pdi");
  // 2. remaining IGST credit -> CGST / SGST, shortfalls first (split in
  //    proportion), then whatever is left — it must be used up first.
  const shortC = Math.max(0, L.camt - C.camt);
  const shortS = Math.max(0, L.samt - C.samt);
  if (C.iamt > 0 && shortC + shortS > 0) {
    const toC = r2(Math.min(shortC, (C.iamt * shortC) / (shortC + shortS)));
    take("iamt", "camt", "i_pdc", toC);
    take("iamt", "samt", "i_pds", shortS);
    take("iamt", "camt", "i_pdc", shortC);
  }
  take("iamt", "camt", "i_pdc");
  take("iamt", "samt", "i_pds");
  // 3. own credit for CGST / SGST, then leftovers towards IGST
  take("camt", "camt", "c_pdc");
  take("samt", "samt", "s_pds");
  take("camt", "iamt", "c_pdi");
  take("samt", "iamt", "s_pdi");
  // 4. cess
  take("csamt", "csamt", "cs_pdcs");

  return {
    paidByItc: used,
    cash: { ipd: L.iamt, cpd: L.camt, spd: L.samt, cspd: L.csamt },
    cashTotal: r2(L.iamt + L.camt + L.samt + L.csamt),
    creditLeft: { iamt: C.iamt, camt: C.camt, samt: C.samt, csamt: C.csamt },
  };
}

/**
 * @param {object} input
 * @param {string} input.gstin
 * @param {string} input.retPeriod "MMYYYY"
 * @param {Array}  input.outward       GSTR-1 builder invoices (each with section, kind, supplyType, pos, ctin, lines[])
 * @param {number} input.outwardBlocked count of sales vouchers the GSTR-1 builder couldn't include
 * @param {Array|null} input.imsRows   IMS rows of the period with { inPeriod, action (final), iamt, camt, samt, cess, invTyp, section }
 * @param {Array}  input.inwardExempt  [{ inter: boolean, value }] purchases with no tax
 * @param {object} [input.openingCredit] electronic credit ledger balance { iamt, camt, samt, csamt } (0 until read from the portal)
 * @param {object} [input.itcFrom2b]    verified GSTR-2B comparison (imsPortal.compare2b) — its 2B figures replace the IMS totals
 * @param {string} [input.imsStage]     stage of the IMS run, to warn when 2B wasn't regenerated and verified
 */
export function buildGstr3b({ gstin, retPeriod, outward, outwardBlocked = 0, imsRows, inwardExempt = [], openingCredit = null, itcFrom2b = null, imsStage = null }) {
  const issues = [];
  const issue = (severity, code, message) => issues.push({ severity, code, message });

  // ---- 3.1 (a) taxable outward, (c) nil/exempt, and 3.2 inter-state to unregistered
  const osupDet = zero();
  let nilExempt = 0;
  const unregByPos = new Map();
  for (const inv of outward) {
    const sign = inv.kind === "CREDIT" ? -1 : 1;
    for (const l of inv.lines) {
      if (l.rate > 0) {
        osupDet.txval += sign * l.txval;
        osupDet.iamt += sign * l.iamt;
        osupDet.camt += sign * l.camt;
        osupDet.samt += sign * l.samt;
        osupDet.csamt += sign * l.csamt;
        if (!inv.ctin && inv.supplyType === "INTER") {
          const a = unregByPos.get(inv.pos) || { pos: inv.pos, txval: 0, iamt: 0 };
          a.txval += sign * l.txval;
          a.iamt += sign * l.iamt;
          unregByPos.set(inv.pos, a);
        }
      } else {
        nilExempt += sign * l.txval;
      }
    }
  }
  if (outwardBlocked > 0) {
    issue("error", "OUTWARD_INCOMPLETE", `${outwardBlocked} sales voucher(s) couldn't be included because of GSTR-1 issues — fix them on the GSTR-1 step so table 3.1 is complete`);
  }

  // ---- 4 eligible ITC from IMS (accepted invoices of this period)
  const itcAvl = { iamt: 0, camt: 0, samt: 0, csamt: 0 };
  const itcRevFromNotes = { iamt: 0, camt: 0, samt: 0, csamt: 0 };
  if (!imsRows) {
    issue("error", "IMS_MISSING", "IMS hasn't been fetched for this period — complete the IMS step so ITC can be claimed");
  } else {
    for (const r of imsRows) {
      if (!r.inPeriod || r.action !== "A") continue;
      // Supplier credit notes reduce ITC; everything else adds to it.
      const target = /CN/.test(r.section) ? itcRevFromNotes : itcAvl;
      target.iamt += r.iamt;
      target.camt += r.camt;
      target.samt += r.samt;
      target.csamt += r.cess;
    }
    const undecided = imsRows.filter((r) => r.inPeriod && !r.action).length;
    if (undecided) issue("error", "IMS_UNDECIDED", `${undecided} IMS invoice(s) still need an accept/reject decision`);
    if (itcFrom2b) {
      const g = (row) => itcFrom2b.rows.find((x) => x.key === row)?.gstr2b || {};
      const inv = g("invoices");
      const cn = g("creditNotes");
      Object.assign(itcAvl, { iamt: inv.igst || 0, camt: inv.cgst || 0, samt: inv.sgst || 0, csamt: inv.cess || 0 });
      Object.assign(itcRevFromNotes, { iamt: cn.igst || 0, camt: cn.cgst || 0, samt: cn.sgst || 0, csamt: cn.cess || 0 });
    } else if (imsStage !== null) {
      issue("warning", "GSTR2B_NOT_VERIFIED", "IMS actions haven't been saved, GSTR-2B regenerated and verified — ITC here is what you accepted in IMS, which GSTN may not match");
    }
  }
  const itcNet = Object.fromEntries(HEADS.map((h) => [h, r2(itcAvl[h] - itcRevFromNotes[h])]));
  if (HEADS.some((h) => itcNet[h] < 0)) {
    issue("error", "ITC_NEGATIVE", "Supplier credit notes exceed this period's ITC — the excess has to be paid as a reversal; review the IMS credit notes");
  }

  // ---- 5 nil / exempt inward
  const inward = inwardExempt.reduce((a, x) => { if (x.inter) a.inter += x.value; else a.intra += x.value; return a; }, { inter: 0, intra: 0 });

  // Items the books can't tell us — reported as zero, flagged once.
  issue("warning", "RCM_NOT_COVERED", "Inward supplies under reverse charge (3.1(d) and ITC in 4(A)(3)) aren't read from the books yet — reported as zero");
  if (osupDet.txval < 0) issue("error", "OUTWARD_NEGATIVE", "Credit notes exceed this period's taxable sales — 3.1(a) can't be negative");

  const payload = {
    gstin,
    ret_period: retPeriod,
    sup_details: {
      osup_det: round(osupDet),
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: r2(nilExempt) },
      isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
      osup_nongst: { txval: 0 },
    },
    inter_sup: {
      unreg_details: [...unregByPos.values()].map(round).filter((x) => x.txval !== 0),
      comp_details: [],
      uin_details: [],
    },
    itc_elg: {
      itc_avl: [
        { ty: "IMPG", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "IMPS", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "ISRC", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "ISD", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", ...round(itcAvl) },
      ],
      itc_rev: [
        { ty: "RUL", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", ...round(itcRevFromNotes) },
      ],
      itc_net: itcNet,
      itc_inelg: [
        { ty: "RUL", iamt: 0, camt: 0, samt: 0, csamt: 0 },
        { ty: "OTH", iamt: 0, camt: 0, samt: 0, csamt: 0 },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: r2(inward.inter), intra: r2(inward.intra) },
        { ty: "NONGST", inter: 0, intra: 0 },
      ],
    },
  };

  // ---- tax payment
  const liability = { iamt: r2(osupDet.iamt), camt: r2(osupDet.camt), samt: r2(osupDet.samt), csamt: r2(osupDet.csamt) };
  const credit = Object.fromEntries(HEADS.map((h) => [h, r2(Math.max(0, itcNet[h]) + (openingCredit?.[h] || 0))]));
  const payment = setOffLiability(
    Object.fromEntries(HEADS.map((h) => [h, Math.max(0, liability[h])])),
    credit
  );

  const errorCount = issues.filter((i) => i.severity === "error").length;
  return {
    payload,
    liability,
    itc: { available: round(itcAvl), reversed: round(itcRevFromNotes), net: itcNet, openingCredit: openingCredit || null, creditUsed: credit },
    payment,
    issues,
    stats: {
      outwardInvoices: outward.length,
      outputTax: r2(liability.iamt + liability.camt + liability.samt + liability.csamt),
      itcNet: r2(HEADS.reduce((a, h) => a + itcNet[h], 0)),
      cashPayable: payment.cashTotal,
      isNil: outward.length === 0 && HEADS.every((h) => !itcNet[h]) && !inward.inter && !inward.intra,
      errors: errorCount,
      warnings: issues.length - errorCount,
    },
  };
}
