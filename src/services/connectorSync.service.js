// =========================================
// src/services/connectorSync.service.js
//
// Replaces direct sendToTally() calls in sync routes.
// Creates a connector job, waits for the connector to
// execute it against Tally, and returns the response XML.
// =========================================

import pool from "../db/index.js";
import { createConnectorJob } from "./connectorJob.service.js";

const POLL_INTERVAL_MS = 500;    // check every 0.5 seconds ✅ FASTER!
const TIMEOUT_MS = 120000;       // give up after 2 minutes

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves which connector (user_id) owns the paired machine for a company.
 */
async function resolveConnectorPairing(companyId, userId) {
  const pairingResult = userId
    ? await pool.query(
        `
        SELECT cpt.user_id
        FROM app_test.connector_pairing_tokens cpt
        WHERE cpt.company_id = $1
          AND cpt.user_id = $2
          AND cpt.is_used = TRUE
        ORDER BY cpt.created_at DESC
        LIMIT 1
        `,
        [companyId, userId]
      )
    : await pool.query(
        // Fallback for existing routes that don't pass userId yet
        `
        SELECT cpt.user_id
        FROM app_test.connector_pairing_tokens cpt
        WHERE cpt.company_id = $1
          AND cpt.is_used = TRUE
        ORDER BY cpt.created_at DESC
        LIMIT 1
        `,
        [companyId]
      );

  const pairing = pairingResult.rows[0];

  if (!pairing) {
    throw new Error(
      userId
        ? `No connector pairing found for company ${companyId} and user ${userId}`
        : `No connector pairing found for company ${companyId}`
    );
  }

  return pairing;
}

/**
 * Creates a connector job for a sync XML request and returns immediately
 * with its id — does NOT wait for the connector to execute it.
 *
 * Split out from sendToTallyViaConnector() so callers that need to fire
 * several independent Tally requests (e.g. company details + GST details,
 * which don't depend on each other) can create all the jobs up front and
 * then wait on them concurrently, instead of awaiting each one serially —
 * a serial await-then-create pattern starves the connector's own parallel
 * job processing of more than one job at a time.
 *
 * @returns {Promise<number>} connector job id
 */
export async function createConnectorSyncJob(
  companyId,
  xml,
  syncType = "sync",
  userId = null
) {
  const pairing = await resolveConnectorPairing(companyId, userId);

  console.log(
    `🔗 Connector resolved: company=${companyId}, user=${pairing.user_id}`
  );

  const connectorJob = await createConnectorJob({
    userId: pairing.user_id,
    jobType: syncType,
    requestXml: xml,
    payload: {
      company_id: companyId,
      user_id: pairing.user_id,
      sync: true
    }
  });

  console.log(
    `🔄 Sync connector job created: ${connectorJob.id} (${syncType}) user=${pairing.user_id}`
  );

  return connectorJob.id;
}

/**
 * Polls a connector job (created via createConnectorSyncJob) until it
 * completes, fails, or times out.
 *
 * @returns {Promise<string>} response XML from Tally
 */
export async function waitForConnectorSyncJob(connectorJobId) {
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {

    await sleep(POLL_INTERVAL_MS);

    const result = await pool.query(
      `
      SELECT status, response_xml, error_message
      FROM app_test.connector_jobs
      WHERE id = $1
      `,
      [connectorJobId]
    );

    const job = result.rows[0];

    if (!job) {
      throw new Error(
        `Connector job ${connectorJobId} disappeared`
      );
    }

    console.log(
      `🔄 Polling connector job ${connectorJobId}: status=${job.status}`
    );

    if (job.status === "completed") {
      console.log(
        `✅ Sync connector job completed: ${connectorJobId}`
      );

      return job.response_xml || "";
    }

    if (job.status === "failed") {
      throw new Error(
        job.error_message ||
        `Sync connector job ${connectorJobId} failed`
      );
    }
  }

  throw new Error(
    `Sync timed out after ${TIMEOUT_MS / 1000}s — is the Connector running?`
  );
}

/**
 * Send a sync XML request to Tally through the Connector, waiting for the
 * result before returning. Kept as the default for existing single-request
 * call sites — use createConnectorSyncJob()/waitForConnectorSyncJob()
 * directly when firing multiple independent requests that should run
 * concurrently.
 *
 * @param {number} companyId - app_test.companies.id
 * @param {string} xml       - Tally request XML
 * @param {string} syncType  - label for logging e.g. 'sync_ledgers'
 * @returns {Promise<string>} - response XML from Tally
 */
export async function sendToTallyViaConnector(
  companyId,
  xml,
  syncType = "sync",
  userId = null
) {
  const connectorJobId = await createConnectorSyncJob(companyId, xml, syncType, userId);
  return await waitForConnectorSyncJob(connectorJobId);
}