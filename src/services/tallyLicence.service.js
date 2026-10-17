// =========================================
// src/services/tallyLicence.service.js
//
// Asks the connector's TallyPrime whether it has an active licence ($$LicenseInfo:IsLicensedMode)
// and remembers the answer on that connector's API key. It is asked only when something real
// happens: a sync starts (manual sync, or the first sync a pairing starts) and when a connector is
// paired. No timer, no polling.
//
//   true  = licensed          false = Educational mode (no active licence)
//   null  = could not tell (Tally closed, no usable answer) - shown as "unknown", never "inactive"
// =========================================

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendToTallyViaConnector, CONNECTOR_NOT_PICKING_UP_CODE } from "./connectorSync.service.js";
import { resolveConnectorForCompany } from "./connectorOwner.service.js";

const LICENCE_XML = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>EXPORT</TALLYREQUEST><TYPE>FUNCTION</TYPE><ID>$$LicenseInfo</ID></HEADER><BODY><DESC><FUNCPARAMLIST><PARAM>IsLicensedMode</PARAM></FUNCPARAMLIST></DESC></BODY></ENVELOPE>`;

// Shown to the user when a sync is refused because the licence is not active. The sync cooldown also
// recognises this exact text: a sync that did no work for this reason must not start the 5-minute wait.
export const LICENCE_INACTIVE_MESSAGE =
  "TallyPrime licence is not active (Educational mode). Activate the licence on the Tally computer, then sync again.";

// Tally answers: <STATUS>1</STATUS> ... <RESULT TYPE="Logical">Yes</RESULT>
export function parseLicenceReply(xml) {
  const body = String(xml || "");
  if (!/<STATUS>\s*1\s*<\/STATUS>/.test(body)) return null;

  const answer = body.match(/<RESULT[^>]*>\s*([^<]*?)\s*<\/RESULT>/i)?.[1]?.toLowerCase();
  if (answer === "yes" || answer === "1" || answer === "true") return true;
  if (answer === "no" || answer === "0" || answer === "false") return false;
  return null;
}

// Never throws, except when the connector is not picking up requests at all: callers that want to
// stop on that (the sync worker) can see it, callers that don't (pairing) just ignore the rejection.
export async function recordTallyLicence(companyId, userId) {
  if (!companyId || !userId) {
    // Never skip silently: a skipped check would let an unlicensed Tally sync through.
    console.warn(`Tally licence check skipped: missing ${!companyId ? "companyId" : "userId"} (companyId=${companyId}, userId=${userId})`);
    return null;
  }

  let licensed = null;
  try {
    const reply = await sendToTallyViaConnector(companyId, LICENCE_XML, "sync", userId);
    licensed = parseLicenceReply(reply);
  } catch (err) {
    if (String(err.message).includes(CONNECTOR_NOT_PICKING_UP_CODE)) throw err;
    console.log(`Tally licence check for company ${companyId}: no answer (${err.message}) - recorded as unknown`);
  }

  try {
    const connector = await resolveConnectorForCompany(companyId, userId);
    if (connector?.api_key_id) {
      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.connector_api_keys
        SET tally_licensed = $2, tally_licence_checked_at = NOW()
        WHERE id = $1
        `,
        [connector.api_key_id, licensed]
      );
    }
  } catch (err) {
    console.error("Could not save the Tally licence status:", err.message);
  }

  console.log(`Tally licence for company ${companyId}: ${licensed === null ? "unknown" : licensed ? "active" : "NOT active (Educational mode)"}`);
  return licensed;
}
