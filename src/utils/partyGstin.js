// src/utils/partyGstin.js
//
// Checks on a party ledger's GSTIN before it is saved, so a typo or the
// company's own GSTIN doesn't turn into a failed match or a rejected invoice
// at return time. Pure: the caller supplies the company's own GSTIN.

import { isValidGstin } from "../services/gstr1/gstMasters.js";

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

/**
 * @returns {string|null} a message when the GSTIN (or GSTIN + PAN pair) is not acceptable, else null.
 */
export function partyGstinProblem({ gstin, pan, ownGstin }) {
  const g = String(gstin || "").trim().toUpperCase();
  if (!g) return null; // unregistered party: nothing to check
  if (!isValidGstin(g)) {
    return `GSTIN "${g}" is not valid (format or check digit is wrong) — re-check it against the party's GST certificate`;
  }
  if (ownGstin && g === String(ownGstin).trim().toUpperCase()) {
    return "This is your own company's GSTIN — a party can't carry it";
  }
  const p = String(pan || "").trim().toUpperCase();
  if (PAN_RE.test(p) && g.slice(2, 12) !== p) {
    return `GSTIN ${g} contains PAN ${g.slice(2, 12)}, which doesn't match the PAN ${p} on this ledger`;
  }
  return null;
}
