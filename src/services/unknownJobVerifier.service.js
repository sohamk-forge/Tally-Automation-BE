import pool from "../db/index.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";
import { getVoucherReferenceExistsXML } from "./xmlBuilder.js";
import { failConnectorJobBusinessRecord } from "./connectorJobResult.service.js";
import { CONNECTOR_ONLINE_WINDOW } from "./connectorOwner.service.js";
import { parseXML } from "./parser.js";

/**
 * Resolves connector jobs stuck in 'unknown' (the connector claimed them, Tally
 * may or may not have imported them, and no result ever arrived) by asking
 * Tally directly whether a voucher with the job's reference exists. Nothing is
 * ever re-sent to Tally:
 *   found      -> job 'completed', invoice 'success'
 *   not found  -> job 'failed',    invoice 'failed' ("safe to retry")
 * If the connector is offline or the question can't be answered, the job stays
 * 'unknown' and is tried again next run (the reaper still fails it after its
 * grace period, with a "check Tally before retrying" message).
 */

// Types whose Tally voucher carries REFERENCE = invoice_no (see generator.py /
// sales_generator.py) and whose business row we know how to update.
const VERIFIABLE = {
  sales_invoice: { voucherType: "Sales", table: "sales_invoice_extractions" },
  purchase_invoice: { voucherType: "Purchase", table: "invoice_extractions" },
};

const WAIT_BEFORE_VERIFY = "2 minutes"; // give the connector's outbox time to deliver first
const MAX_PER_RUN = 10;
const verifyingNow = new Set();

async function connectorIsOnline(userId) {
  const r = await pool.query(
    `SELECT 1 FROM app_test.connector_api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
       AND last_seen_at >= NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'
     LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

async function verifyOne(job) {
  const spec = VERIFIABLE[job.job_type];
  const { company_id: companyId, invoice_id: invoiceId, invoice_no: invoiceNo } = job.payload || {};
  if (!spec || !companyId || !invoiceId || !invoiceNo) return "skipped";

  if (!(await connectorIsOnline(job.user_id))) return "connector-offline";

  const company = await pool.query(`SELECT name FROM app_test.companies WHERE id = $1`, [companyId]);
  const companyName = company.rows[0]?.name;
  if (!companyName) return "skipped";

  const responseXml = await sendToTallyViaConnector(
    companyId,
    getVoucherReferenceExistsXML(companyName, invoiceNo, spec.voucherType),
    "unknown_job_verify",
    job.user_id
  );
  const parsed = parseXML(responseXml);
  const found = Boolean(parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER);

  if (found) {
    const note = "Result was lost, but the voucher exists in Tally - verified automatically.";
    // Only touch rows still unresolved: a late real result may have landed meanwhile.
    const done = await pool.query(
      `UPDATE app_test.connector_jobs
       SET status = 'completed', error_message = NULL, completed_at = NOW(), updated_at = NOW(),
           result = jsonb_build_object('verified_in_tally', true)
       WHERE id = $1 AND status = 'unknown'`,
      [job.id]
    );
    if (done.rowCount > 0) {
      await pool.query(
        `UPDATE app_test.${spec.table}
         SET sync_status = 'success', error_message = NULL, tally_response = $1, updated_at = NOW()
         WHERE id = $2`,
        [note, invoiceId]
      );
    }
    return "found";
  }

  const message = "Not found in Tally after the connector lost its result - safe to retry.";
  const failed = await pool.query(
    `UPDATE app_test.connector_jobs
     SET status = 'failed', error_message = $2, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'unknown'`,
    [job.id, message]
  );
  if (failed.rowCount > 0) {
    await failConnectorJobBusinessRecord(pool, job, message);
  }
  return "not-found";
}

export async function verifyUnknownConnectorJobs() {
  const jobs = await pool.query(
    `SELECT id, user_id, job_type, payload
     FROM app_test.connector_jobs
     WHERE status = 'unknown'
       AND job_type = ANY($1)
       AND updated_at < NOW() - INTERVAL '${WAIT_BEFORE_VERIFY}'
     ORDER BY updated_at ASC
     LIMIT ${MAX_PER_RUN}`,
    [Object.keys(VERIFIABLE)]
  );

  for (const job of jobs.rows) {
    if (verifyingNow.has(job.id)) continue;
    verifyingNow.add(job.id);
    try {
      const outcome = await verifyOne(job);
      if (outcome === "found" || outcome === "not-found") {
        console.log(`[unknown-verify] job ${job.id} (${job.job_type}): ${outcome}`);
      }
    } catch (err) {
      // Leave it 'unknown'; next run retries, and the reaper's grace period is the backstop.
      console.warn(`[unknown-verify] job ${job.id} could not be verified: ${err.message}`);
    } finally {
      verifyingNow.delete(job.id);
    }
  }
}
