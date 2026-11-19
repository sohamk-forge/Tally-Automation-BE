// src/services/companyGstStatus.service.js
//
// A company is non-GST when Tally's company details carry no GSTIN.
// The GSTIN is imported from Tally into company_details by the company sync.
// The decision itself now lives in the company profile (companyProfile.service.js);
// this stays as the one-line answer the push workers already call. A company that was
// never synced has no GSTIN on record, so it still counts as non-GST here, as before.
import { getCompanyGst } from "./companyProfile.service.js";
import { GST_MODE } from "./companyProfileRules.js";

export async function isNonGstCompany(companyId) {
  const gst = await getCompanyGst(companyId);
  return gst.mode !== GST_MODE.GST;
}
