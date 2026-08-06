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
 * Send a sync XML request to Tally through the Connector.
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

  // STEP 1: FIND CORRECT CONNECTOR PAIRING
  let pairingResult;

  if (userId) {
    // Prefer the authenticated/requested user's connector
    pairingResult = await pool.query(
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
  } else {
    // Fallback for existing routes that don't pass userId yet
    pairingResult = await pool.query(
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
  }

  const pairing = pairingResult.rows[0];

  if (!pairing) {
    throw new Error(
      userId
        ? `No connector pairing found for company ${companyId} and user ${userId}`
        : `No connector pairing found for company ${companyId}`
    );
  }

  console.log(
    `🔗 Connector resolved: company=${companyId}, user=${pairing.user_id}`
  );

  // STEP 2: CREATE CONNECTOR JOB
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

  // STEP 3: POLL JOB
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {

    await sleep(POLL_INTERVAL_MS);

    const result = await pool.query(
      `
      SELECT status, response_xml, error_message
      FROM app_test.connector_jobs
      WHERE id = $1
      `,
      [connectorJob.id]
    );

    const job = result.rows[0];

    if (!job) {
      throw new Error(
        `Connector job ${connectorJob.id} disappeared`
      );
    }

    console.log(
      `🔄 Polling connector job ${connectorJob.id}: status=${job.status}`
    );

    if (job.status === "completed") {
      console.log(
        `✅ Sync connector job completed: ${connectorJob.id}`
      );

      return job.response_xml || "";
    }

    if (job.status === "failed") {
      throw new Error(
        job.error_message ||
        `Sync connector job ${connectorJob.id} failed`
      );
    }
  }

  throw new Error(
    `Sync timed out after ${TIMEOUT_MS / 1000}s — is the Connector running?`
  );
}