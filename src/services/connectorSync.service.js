// =========================================
// src/services/connectorSync.service.js
//
// Creates connector jobs for Tally sync requests.
// Each job always belongs to the authenticated
// user's connector pairing.
// =========================================

import pool from "../db/index.js";
import { createConnectorJob } from "./connectorJob.service.js";
import { resolveTallyOwner } from "./connectorOwner.service.js";

const POLL_INTERVAL_MS = 250; // check every 1 second

// How long one connector request may take before the caller gives up. The sync worker
// derives each step's HTTP timeout from this (calls x this + 1 min), so the two can
// never drift apart again.
export const CONNECTOR_WAIT_TIMEOUT_MS = 600000; // 10 minutes
const TIMEOUT_MS = CONNECTOR_WAIT_TIMEOUT_MS;

// A running connector polls every second, so a request still unclaimed after this long
// means nothing is picking it up (app closed, not paired, wrong key) - fail fast with a
// clear message instead of waiting the full timeout. Not applied while the same
// connector is busy with another job: it only polls again once its batch finishes.
const UNCLAIMED_LIMIT_MS = 2 * 60 * 1000;
const CONNECTOR_BUSY_WINDOW = "5 minutes"; // same window the stale-claim sweep uses

// The code travels inside the message (routes hand errors back as an HTTP message);
// the sync worker looks for the code to stop the whole sync early.
export const CONNECTOR_NOT_PICKING_UP_CODE = "[CONNECTOR_NOT_PICKING_UP]";
export const CONNECTOR_NOT_PICKING_UP_MESSAGE =
  `${CONNECTOR_NOT_PICKING_UP_CODE} Connector did not pick up the request - make sure the Connector app is running and paired, then sync again.`;

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

  // Accountants/staff are delegated to the company admin's connector.
  const { ownerUserId } = await resolveTallyOwner(companyId, userId);

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
    [companyId, ownerUserId]
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
      requested_by_user_id: userId,
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
      SELECT cj.status, cj.response_xml, cj.error_message, cj.user_id AS owner_user_id,
             EXTRACT(EPOCH FROM (NOW() - cj.created_at)) * 1000 AS age_ms
      FROM app_test.connector_jobs cj
      WHERE cj.id = $1
        AND (
          cj.user_id = $2
          OR EXISTS (
            SELECT 1
            FROM app_test.company_members cm
            WHERE cm.user_id = $2
              AND cm.company_id = NULLIF(cj.payload->>'company_id', '')::int
          )
        )
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

    // Nobody has claimed it for 2 minutes and the connector is not busy with something else.
    // The status = 'pending' guard means a claim landing at this very moment still wins.
    if (
      job.status === "pending" &&
      Number(job.age_ms) > UNCLAIMED_LIMIT_MS &&
      !(await connectorIsBusy(job.owner_user_id))
    ) {
      const failed = await pool.query(
        `
        UPDATE app_test.connector_jobs
        SET status = 'failed', error_message = $2, completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id
        `,
        [connectorJobId, CONNECTOR_NOT_PICKING_UP_MESSAGE]
      );
      if (failed.rowCount > 0) throw new Error(CONNECTOR_NOT_PICKING_UP_MESSAGE);
    }
  }

  // Nobody is waiting any more, so cancel the request: the connector only claims 'pending'
  // rows, so it can never run this later against a sync that has moved on. A late result
  // for a 'failed' job is still accepted and ignored by /api/connector/jobs/result.
  const timeoutMessage = `Sync timed out after ${TIMEOUT_MS / 1000}s - is the Connector running?`;
  await pool.query(
    `
    UPDATE app_test.connector_jobs
    SET status = 'failed', error_message = $2, completed_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND status IN ('pending', 'processing')
    `,
    [connectorJobId, timeoutMessage]
  );
  throw new Error(timeoutMessage);
}

// True while this user's connector has a job it claimed recently and has not reported on.
async function connectorIsBusy(userId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM app_test.connector_jobs
    WHERE user_id = $1
      AND status = 'processing'
      AND claimed_at > NOW() - INTERVAL '${CONNECTOR_BUSY_WINDOW}'
    LIMIT 1
    `,
    [userId]
  );
  return result.rows.length > 0;
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