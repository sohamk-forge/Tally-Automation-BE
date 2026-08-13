// =========================================
// src/services/connectorSync.service.js
//
// Creates connector jobs for Tally sync requests.
// Each job always belongs to the authenticated
// user's connector pairing.
// =========================================

import pool from "../db/index.js";
import { createConnectorJob } from "./connectorJob.service.js";

const POLL_INTERVAL_MS = 1000; // check every 1 second
const TIMEOUT_MS = 600000;     // 10 minutes

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the connector pairing for THIS user AND this
 * specific company.
 *
 * Important:
 * We never select the "latest pairing" across all users
 * of a company. If no row exists matching BOTH company_id
 * and user_id, this throws — which is what makes every
 * route calling sendToTallyViaConnector/createConnectorSyncJob
 * safe against cross-user access, without those routes
 * needing their own separate ownership check.
 *
 * Multi-user flow:
 *   companyId + userId -> user's latest valid pairing for
 *   that specific company
 */
async function resolveConnectorPairing(companyId, userId) {
  if (!userId) {
    throw new Error(
      `userId is required to resolve connector pairing for company ${companyId}`
    );
  }

  const result = await pool.query(
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
  );

  const pairing = result.rows[0];

  if (!pairing) {
    throw new Error(
      `No connector pairing found for company ${companyId} and user ${userId}`
    );
  }

  return pairing;
}

/**
 * Resolve ANY active connector pairing for this user,
 * regardless of company. Used only for discovery flows
 * (e.g. listing companies) where no companyId exists yet —
 * we just need to confirm this user has a paired connector
 * at all before creating a job for it.
 *
 * This intentionally does NOT scope by company_id — do not
 * reuse this for anything that touches a specific company's
 * data. Use resolveConnectorPairing for that.
 */
async function resolveAnyConnectorPairing(userId) {
  if (!userId) {
    throw new Error(`userId is required to resolve connector pairing`);
  }

  const result = await pool.query(
    `
    SELECT cpt.user_id
    FROM app_test.connector_pairing_tokens cpt
    WHERE cpt.user_id = $1
      AND cpt.is_used = TRUE
    ORDER BY cpt.created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  const pairing = result.rows[0];

  if (!pairing) {
    throw new Error(`No connector pairing found for user ${userId}`);
  }

  return pairing;
}

/**
 * Creates a connector job and returns its ID.
 *
 * userId MUST be supplied.
 * The job is always created for that user's connector.
 */
export async function createConnectorSyncJob(
  companyId,
  xml,
  syncType = "sync",
  userId
) {
  if (!userId) {
    throw new Error(`userId is required for connector sync`);
  }

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
 * Creates a connector job for company DISCOVERY — i.e.
 * before any companyId exists. Confirms the user has an
 * active connector pairing, then creates a job tagged with
 * that user_id only (no company_id in the payload).
 *
 * The connector process on the user's machine claims jobs
 * by user_id (see connectorJob.service.js / the connector's
 * own claim query), so this job is only ever visible to and
 * executable by that user's own paired connector — same
 * guarantee as the company-scoped path above, just without
 * requiring a companyId up front.
 */
export async function discoverCompaniesViaConnector(userId, xml, jobType = "companies") {
  if (!userId) {
    throw new Error(`userId is required for connector sync`);
  }

  const pairing = await resolveAnyConnectorPairing(userId);

  console.log(`🔗 Connector resolved for discovery: user=${pairing.user_id}`);

  const connectorJob = await createConnectorJob({
    userId: pairing.user_id,
    jobType,
    requestXml: xml,
    payload: {
      user_id: pairing.user_id,
      sync: true
    }
  });

  console.log(
    `🔄 Company discovery connector job created: ${connectorJob.id} user=${pairing.user_id}`
  );

  return await waitForConnectorSyncJob(connectorJob.id, pairing.user_id);
}

/**
 * Wait for a connector job to complete.
 *
 * Returns the Tally response XML.
 */
export async function waitForConnectorSyncJob(connectorJobId, userId) {
  if (!userId) {
    throw new Error(`userId is required to wait on connector job ${connectorJobId}`);
  }

  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const result = await pool.query(
      `
      SELECT status, response_xml, error_message
      FROM app_test.connector_jobs
      WHERE id = $1
        AND user_id = $2
      `,
      [connectorJobId, userId]
    );

    const job = result.rows[0];

    if (!job) {
      // Either the job doesn't exist, or it exists but belongs to a
      // different user_id than the one polling for it — both cases
      // are treated identically so this never confirms to a caller
      // that a given jobId exists under someone else's account.
      throw new Error(`Connector job ${connectorJobId} disappeared`);
    }

    console.log(`🔄 Polling connector job ${connectorJobId}: status=${job.status}`);

    if (job.status === "completed") {
      console.log(`✅ Sync connector job completed: ${connectorJobId}`);
      return job.response_xml || "";
    }

    if (job.status === "failed") {
      throw new Error(job.error_message || `Sync connector job ${connectorJobId} failed`);
    }
  }

  throw new Error(`Sync timed out after ${TIMEOUT_MS / 1000}s — is the Connector running?`);
}

/**
 * Creates a connector job and waits for the result.
 *
 * Use this for normal single Tally requests scoped to a
 * specific company.
 */
export async function sendToTallyViaConnector(
  companyId,
  xml,
  syncType = "sync",
  userId
) {
  if (!userId) {
    throw new Error(`userId is required for Tally connector sync`);
  }

  const connectorJobId = await createConnectorSyncJob(companyId, xml, syncType, userId);

  return await waitForConnectorSyncJob(connectorJobId, userId);
}